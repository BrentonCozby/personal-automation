import { todayIso } from '@personal-automation/common/date'
import { AppError } from '@personal-automation/common/errors'
import { createProgress } from '@personal-automation/common/progress'
import { createGmailAuth } from '@personal-automation/gmail/auth'
import { createGmailClient, type GmailClient } from '@personal-automation/gmail/client'
import pino from 'pino'
import { type AnalyzeResult, createAnalyzer, type TasksAnalyzer } from './anthropic/client.js'
import { buildAnalysisPrompt, type PromptTask } from './anthropic/prompts.js'
import type { TaskAnalysis } from './anthropic/schemas.js'
import { toCandidate, withTaskClock } from './commands/task-io.js'
import type { Config } from './config.js'
import { buildDigest, type DigestItem } from './digest.js'
import { appendRunLog, type RunLogEntry } from './run-log.js'
import { dueStatus, localIsoDate } from './state/days.js'
import { isStalled, orderByLongestUntouched, untouchedDays } from './state/stall.js'
import { defaultTouchClockPath, type TouchClock } from './state/touch-clock.js'
import { type CapCandidate, countsTowardCap } from './state/wip.js'
import type { ScannedTask } from './tasks/obsidian/scan.js'

export type RunOptions = {
  dryRun: boolean
}

export type RunResult =
  | { kind: 'no_active' }
  | { kind: 'nothing_stalled'; activeCount: number }
  | { kind: 'dry_run'; subject: string; body: string; quietCount: number; activeCount: number }
  | { kind: 'sent'; messageId: string; quietCount: number; activeCount: number }

/** A task as both the state model reads it and the vault holds it, so one pass can do both. */
type Reviewed = CapCandidate & { task: ScannedTask }

/** One quiet task with everything computed about it locally, before the model sees anything. */
type Quiet = {
  task: ScannedTask
  untouchedDays: number
  isDatePassed: boolean
}

/**
 * Reviews the tasks you are carrying and emails the ones that have gone quiet.
 *
 * Silent in two cases, both deliberate: nothing is `#active`, or everything `#active` was touched
 * inside the stall window. A message about not having committed to anything, or about work that is
 * moving, is the deficit feeling this whole model exists to avoid.
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
    act: async ({ open, clock }) => ({
      clock,
      result: await review({ open, clock, config, opts, now, analyzer, gmail, runsDir, logger }),
    }),
  })
}

async function review({
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
  logger.info({ open: open.length, active: active.length, quiet: quiet.length }, 'Read the vault.')

  if (active.length === 0) {
    logger.info('Nothing is #active, so there is nothing to review.')

    return { kind: 'no_active' }
  }
  if (quiet.length === 0) {
    logger.info({ activeCount: active.length }, 'Every active task was touched recently; no email.')

    return { kind: 'nothing_stalled', activeCount: active.length }
  }

  const analyses = await analyze({ quiet, config, analyzer, logger })
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

  const digest = buildDigest({ items, activeCount: active.length })
  const today = todayIso()
  appendRunLog({
    entries: items.map(item => toRunLogEntry({ item, dryRun: opts.dryRun, now, today })),
    today,
    ...(runsDir !== undefined ? { dir: runsDir } : {}),
  })

  if (opts.dryRun) {
    return {
      kind: 'dry_run',
      subject: digest.subject,
      body: digest.body,
      quietCount: items.length,
      activeCount: active.length,
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
  logger.info({ to: config.toEmail }, 'Sending digest…')
  const sent = await client.sendMessage({
    to: config.toEmail,
    subject: digest.subject,
    body: digest.body,
    html: digest.html,
  })
  logger.info({ messageId: sent.id, quietCount: items.length }, 'Digest sent.')

  return {
    kind: 'sent',
    messageId: sent.id,
    quietCount: items.length,
    activeCount: active.length,
  }
}

// The tasks being carried, and of those the ones that have gone quiet, longest untouched first.
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
}): { active: Reviewed[]; quiet: Quiet[] } {
  const reviewed: Reviewed[] = open.map(task => ({ ...toCandidate({ task, clock }), task }))
  const active = reviewed.filter(countsTowardCap)
  const stalled = orderByLongestUntouched(
    active.filter(task => isStalled({ task, stallDays, now })),
  )

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
}: {
  quiet: Quiet[]
  config: Config
  analyzer: TasksAnalyzer
  logger: pino.Logger
}): Promise<TaskAnalysis[]> {
  const promptTasks: PromptTask[] = quiet.map(entry => ({
    title: entry.task.title,
    notes: entry.task.notes,
    list: entry.task.list,
    untouchedDays: entry.untouchedDays,
    isDatePassed: entry.isDatePassed,
  }))
  const prompt = buildAnalysisPrompt({ tasks: promptTasks, today: todayIso() })

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
