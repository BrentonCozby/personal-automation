import { todayIso } from '@personal-automation/common/date'
import { AppError } from '@personal-automation/common/errors'
import { createProgress } from '@personal-automation/common/progress'
import { createGmailAuth } from '@personal-automation/gmail/auth'
import { createGmailClient, type GmailClient } from '@personal-automation/gmail/client'
import pino from 'pino'
import { type AnalyzeResult, createAnalyzer, type TasksAnalyzer } from './anthropic/client.js'
import { buildAnalysisPrompt, type PromptTask } from './anthropic/prompts.js'
import type { TaskAnalysis } from './anthropic/schemas.js'
import { type ScannedCandidate, toCandidate, withTaskClock } from './commands/task-io.js'
import type { Config } from './config.js'
import { buildDigest, type Digest, type DigestItem, type DoneSummary } from './digest.js'
import { readOverrides } from './overrides.js'
import { appendRunLog, type RunLogEntry } from './run-log.js'
import { type CapSuggestion, suggestCapRaise } from './state/cap-suggestion.js'
import { dueStatus, localIsoDate } from './state/days.js'
import { closedSince, countMoved } from './state/done.js'
import { isStalled, untouchedDays } from './state/stall.js'
import { defaultTouchClockPath, type TouchClock } from './state/touch-clock.js'
import { countsTowardCap, orderByClosestToDone } from './state/wip.js'
import type { ScannedTask } from './tasks/obsidian/scan.js'

export type RunOptions = {
  dryRun: boolean
}

/**
 * Nothing was sent, and why. Both reasons also mean the done list was empty: a record of what you
 * finished sends on its own, so silence requires both halves to have nothing in them.
 */
export type SilentReason = 'no_active' | 'nothing_stalled'

export type RunResult =
  | { kind: 'silent'; reason: SilentReason; activeCount: number }
  | {
      kind: 'dry_run'
      subject: string
      body: string
      quietCount: number
      doneCount: number
      activeCount: number
    }
  | {
      kind: 'sent'
      messageId: string
      quietCount: number
      doneCount: number
      activeCount: number
    }

/** A task as both the state model reads it and the vault holds it, so one pass can do both. */
/** One quiet task with everything computed about it locally, before the model sees anything. */
type Quiet = {
  task: ScannedTask
  untouchedDays: number
  isDatePassed: boolean
}

/**
 * Reviews the tasks you are carrying: emails the ones that have gone quiet, and the record of what
 * the last few days produced.
 *
 * Silence needs both halves to be empty. Nothing `#active`, or nothing quiet, means there is no ask
 * to make, because a message about not having committed to anything or about work that is moving is
 * the deficit feeling this whole model exists to avoid. But a record of what you finished or dropped
 * is not an ask, so it sends on its own: a to-do list can only ever show the shortfall, and the
 * counterweight has to be able to arrive on a week when nothing is wrong.
 *
 * Runs through the same touch clock as the editing commands, so a twice-weekly review is also what
 * keeps the clock current.
 */
export async function runDigest({
  config,
  scopes,
  opts,
  now = new Date(),
  analyzer = createAnalyzer({ apiKey: config.anthropicApiKey, model: config.model }),
  gmail,
  clockPath = defaultTouchClockPath(),
  runsDir,
  logger = pino({ level: 'info' }),
}: {
  config: Config
  scopes: readonly string[]
  opts: RunOptions
  now?: Date
  analyzer?: TasksAnalyzer
  gmail?: GmailClient
  clockPath?: string
  runsDir?: string
  logger?: pino.Logger
}): Promise<RunResult> {
  // No day-gate: the launchd agent fires this only on the scheduled days/times (or the user
  // ran it manually), so when it runs, it runs.
  return await withTaskClock<RunResult>({
    vaultPath: config.obsidianVaultPath,
    scopes,
    clockPath,
    now,
    // Reviewing a task is not touching it, so the clock goes back unchanged: reconciling it against
    // the vault is the only thing this run does to it.
    act: async ({ tasks, open, clock }) => ({
      clock,
      result: await review({
        tasks,
        open,
        clock,
        config,
        opts,
        now,
        analyzer,
        gmail,
        runsDir,
        logger,
      }),
    }),
  })
}

async function review({
  tasks,
  open,
  clock,
  config,
  opts,
  now,
  analyzer,
  gmail,
  runsDir,
  logger,
}: {
  tasks: ScannedTask[]
  open: ScannedTask[]
  clock: TouchClock
  config: Config
  opts: RunOptions
  now: Date
  analyzer: TasksAnalyzer
  gmail: GmailClient | undefined
  runsDir: string | undefined
  logger: pino.Logger
}): Promise<RunResult> {
  const { active, quiet } = partition({ open, clock, stallDays: config.stallDays, now })
  const windowDays = config.doneWindowDays
  const closed = closedSince({ tasks, windowDays, now })
  const done: DoneSummary = {
    ...closed,
    windowDays,
    movedCount: countMoved({ active, windowDays, now }),
  }
  // Closures rather than entries, so this agrees with the counts the email prints: a chore done three
  // times is three things done, on one line.
  const doneCount = closed.finishedCount + closed.droppedCount
  logger.info(
    { open: open.length, active: active.length, quiet: quiet.length, doneCount },
    'Read the vault.',
  )
  // Read before the model call, so a log this can't parse fails the run without spending anything.
  const capSuggestion = capRaise({ config, now, runsDir })
  if (capSuggestion) {
    logger.info(
      { overrideCount: capSuggestion.overrideCount, suggestedCap: capSuggestion.suggestedCap },
      'The cap has been raised often enough to suggest changing it.',
    )
  }

  // The two halves are gated separately. Whichever of them has something decides the email; only an
  // empty pair is silent.
  if (quiet.length === 0) {
    const reason: SilentReason = active.length === 0 ? 'no_active' : 'nothing_stalled'
    if (doneCount === 0) {
      logger.info({ reason, activeCount: active.length }, 'Nothing to say; no email.')

      return { kind: 'silent', reason, activeCount: active.length }
    }

    return await deliver({
      digest: buildDigest({
        items: [],
        activeCount: active.length,
        done,
        ...(capSuggestion ? { capSuggestion } : {}),
      }),
      quietCount: 0,
      doneCount,
      activeCount: active.length,
      config,
      opts,
      gmail,
      logger,
    })
  }

  const analyses = await analyze({ quiet, config, analyzer, logger, now })
  const items = joinAnalyses({ analyses, quiet })
  const unanalyzed = quiet.length - items.length
  if (unanalyzed > 0) {
    logger.warn(
      { unanalyzed, quiet: quiet.length },
      'Some tasks received no analysis; they are absent from this digest.',
    )
  }
  // Reporting this as "nothing has gone quiet" would say the opposite of what happened, and the
  // run would look clean. It failed, so it exits non-zero and the launchd wrapper notifies.
  if (items.length === 0) {
    throw new AppError({
      message: `The model returned no usable analysis for ${quiet.length} quiet ${quiet.length === 1 ? 'task' : 'tasks'}, so nothing was sent.`,
      retryable: true,
    })
  }

  const today = todayIso()
  appendRunLog({
    entries: items.map(item => toRunLogEntry({ item, dryRun: opts.dryRun, now, today })),
    today,
    ...(runsDir !== undefined ? { dir: runsDir } : {}),
  })

  return await deliver({
    digest: buildDigest({
      items,
      activeCount: active.length,
      done,
      ...(capSuggestion ? { capSuggestion } : {}),
    }),
    quietCount: items.length,
    doneCount,
    activeCount: active.length,
    config,
    opts,
    gmail,
    logger,
  })
}

/** What to say about the cap itself, or undefined when it is holding. */
function capRaise({
  config,
  now,
  runsDir,
}: {
  config: Config
  now: Date
  runsDir: string | undefined
}): CapSuggestion | undefined {
  return suggestCapRaise({
    entries: readOverrides(runsDir !== undefined ? { dir: runsDir } : {}),
    cap: config.wipCap,
    windowDays: config.overrideWindowDays,
    limit: config.overrideLimit,
    now,
  })
}

/** Prints the email or sends it, so both halves of the review leave by the same door. */
async function deliver({
  digest,
  quietCount,
  doneCount,
  activeCount,
  config,
  opts,
  gmail,
  logger,
}: {
  digest: Digest
  quietCount: number
  doneCount: number
  activeCount: number
  config: Config
  opts: RunOptions
  gmail: GmailClient | undefined
  logger: pino.Logger
}): Promise<RunResult> {
  if (opts.dryRun) {
    return {
      kind: 'dry_run',
      subject: digest.subject,
      body: digest.body,
      quietCount,
      doneCount,
      activeCount,
    }
  }

  const client =
    gmail ??
    createGmailClient({
      auth: createGmailAuth({
        clientId: config.gmailClientId,
        clientSecret: config.gmailClientSecret,
        refreshToken: config.gmailRefreshToken,
      }),
    })
  logger.info({ to: config.toEmail }, 'Sending the review…')
  const sent = await client.sendMessage({
    to: config.toEmail,
    subject: digest.subject,
    body: digest.body,
    html: digest.html,
  })
  logger.info({ messageId: sent.id, quietCount, doneCount }, 'Review sent.')

  return { kind: 'sent', messageId: sent.id, quietCount, doneCount, activeCount }
}

// The tasks being carried, and of those the ones that have gone quiet, closest to done first.
//
// That order is the cap's own, and it is the point rather than a detail: pointing at the quietest
// task points at the one hardest to restart, when finishing one thing beats resuming everything.
// Everything else in the vault is out of scope by design: `#someday` is a holding pool and untagged
// is the permanent steady state, so neither is counted or reported on.
function partition({
  open,
  clock,
  stallDays,
  now,
}: {
  open: ScannedTask[]
  clock: TouchClock
  stallDays: number
  now: Date
}): { active: ScannedCandidate[]; quiet: Quiet[] } {
  const reviewed: ScannedCandidate[] = open.map(task => ({ ...toCandidate({ task, clock }), task }))
  const active = reviewed.filter(countsTowardCap)
  const stalled = orderByClosestToDone(active.filter(task => isStalled({ task, stallDays, now })))

  return {
    active,
    quiet: stalled.flatMap(entry => {
      const quietDays = untouchedDays({ task: entry, now })
      // Unreachable: a task the clock has never seen never stalls. Narrowed rather than defaulted,
      // so no invented day count can reach the email.
      if (quietDays === undefined) return []

      return [
        {
          task: entry.task,
          untouchedDays: quietDays,
          isDatePassed: dueStatus({ due: entry.due, now }) === 'past',
        },
      ]
    }),
  }
}

async function analyze({
  quiet,
  config,
  analyzer,
  logger,
  now,
}: {
  quiet: Quiet[]
  config: Config
  analyzer: TasksAnalyzer
  logger: pino.Logger
  now: Date
}): Promise<TaskAnalysis[]> {
  const promptTasks: PromptTask[] = quiet.map(entry => ({
    title: entry.task.title,
    notes: entry.task.notes,
    list: entry.task.list,
    untouchedDays: entry.untouchedDays,
    isDatePassed: entry.isDatePassed,
  }))
  // The local calendar date, not `todayIso`: every day count the prompt carries was measured in
  // local days, and on an evening run the UTC date is already tomorrow.
  const prompt = buildAnalysisPrompt({ tasks: promptTasks, today: localIsoDate(now) })

  // The slow step: one Anthropic call that returns everything at once. Log it (so launchd output and
  // the terminal both show the wait) and spin so the run never looks stuck.
  logger.info({ tasks: promptTasks.length, model: config.model }, 'Analyzing the quiet tasks…')
  const spinner = createProgress({
    enabled: process.stdout.isTTY === true,
    label: `Analyzing ${promptTasks.length} quiet tasks with ${config.model}…`,
  })
  let result: AnalyzeResult
  try {
    result = await analyzer.analyze({ prompt, taskCount: promptTasks.length })
  } catch (err) {
    spinner.fail('Analysis failed')
    throw err
  }
  spinner.succeed(
    `Analyzed ${result.analyses.length} tasks in ${Math.round(result.latencyMs / 1000)}s`,
  )
  logger.info(
    {
      analyses: result.analyses.length,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
    'Analyzed tasks.',
  )

  return result.analyses
}

// Joins each analysis back to its task by index (the model echoes the task's input position).
// Matching by index still works when the model paraphrases the title; an out-of-range or duplicate
// index is dropped rather than mis-joined. The input order is the digest's order, so the join
// restores it rather than trusting the order the analyses came back in.
function joinAnalyses({
  analyses,
  quiet,
}: {
  analyses: TaskAnalysis[]
  quiet: Quiet[]
}): DigestItem[] {
  const byIndex = new Map<number, TaskAnalysis>()
  for (const analysis of analyses) {
    if (!byIndex.has(analysis.index)) byIndex.set(analysis.index, analysis)
  }

  return quiet.flatMap((entry, index) => {
    const analysis = byIndex.get(index)
    if (!analysis) return []

    return [
      {
        title: entry.task.title,
        list: entry.task.list,
        classification: analysis.classification,
        reasoning: analysis.reasoning,
        suggestedNextAction: analysis.suggested_next_action,
        untouchedDays: entry.untouchedDays,
        passedDueDate: entry.isDatePassed && entry.task.due ? localIsoDate(entry.task.due) : null,
      },
    ]
  })
}

function toRunLogEntry({
  item,
  dryRun,
  now,
  today,
}: {
  item: DigestItem
  dryRun: boolean
  now: Date
  today: string
}): RunLogEntry {
  return {
    timestamp: now.toISOString(),
    date: today,
    dry_run: dryRun,
    title: item.title,
    list: item.list,
    classification: item.classification,
    untouched_days: item.untouchedDays,
    due_date_passed: item.passedDueDate !== null,
    suggested_next_action: item.suggestedNextAction,
  }
}
