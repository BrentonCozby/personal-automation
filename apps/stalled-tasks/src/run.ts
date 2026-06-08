import { todayIso } from '@personal-automation/common/date'
import { createProgress } from '@personal-automation/common/progress'
import { createGmailAuth } from '@personal-automation/gmail/auth'
import { createGmailClient, type GmailClient } from '@personal-automation/gmail/client'
import pino from 'pino'
import {
  type AnalyzeResult,
  createAnalyzer,
  type StalledTasksAnalyzer,
} from './anthropic/client.js'
import { buildAnalysisPrompt, type PromptTask } from './anthropic/prompts.js'
import type { TaskAnalysis } from './anthropic/schemas.js'
import type { Config } from './config.js'
import { buildDigest, type DigestItem } from './digest.js'
import { appendRunLog, type RunLogEntry } from './run-log.js'
import { type DueStatus, dueStatus, staleDays } from './staleness.js'
import { createTaskSource } from './tasks/source.js'
import type { Task, TaskSource } from './tasks/types.js'

export type RunOptions = {
  dryRun: boolean
}

export type RunResult =
  | { kind: 'no_open_tasks' }
  | { kind: 'no_actionable'; totalStalled: number }
  | { kind: 'dry_run'; subject: string; body: string; flaggedCount: number; totalStalled: number }
  | { kind: 'sent'; messageId: string; flaggedCount: number; totalStalled: number }

type Enriched = {
  task: Task
  staleDays: number | null
  dueStatus: DueStatus
}

export async function runStalledTasks({
  config,
  opts,
  now = new Date(),
  source = createTaskSource({
    provider: config.taskProvider,
    lists: config.taskLists,
    ...(config.obsidianVaultPath !== undefined ? { vaultPath: config.obsidianVaultPath } : {}),
  }),
  analyzer = createAnalyzer({ apiKey: config.anthropicApiKey, model: config.model }),
  gmail,
  runsDir,
  logger = pino({ level: 'info' }),
}: {
  config: Config
  opts: RunOptions
  now?: Date
  source?: TaskSource
  analyzer?: StalledTasksAnalyzer
  gmail?: GmailClient
  runsDir?: string
  logger?: pino.Logger
}): Promise<RunResult> {
  // No day-gate: the launchd agent fires this only on the scheduled days/times (or the user
  // ran it manually), so when it runs, it runs.
  const spinnersEnabled = process.stdout.isTTY === true

  // Throws a clear AppError on a task-source access failure — never an empty list that would
  // read as "nothing is stalled".
  logger.info('Reading open tasks…')
  const tasks = await source.list()
  logger.info({ count: tasks.length }, 'Read open tasks.')
  if (tasks.length === 0) {
    logger.info('No open tasks found.')

    return { kind: 'no_open_tasks' }
  }

  const enriched: Enriched[] = tasks.map(task => ({
    task,
    staleDays: staleDays({ task, now }),
    dueStatus: dueStatus({ due: task.due, now }),
  }))

  const promptTasks: PromptTask[] = enriched.map(e => ({
    title: e.task.title,
    notes: e.task.notes,
    list: e.task.list,
    staleDays: e.staleDays,
    dueStatus: e.dueStatus,
  }))
  const prompt = buildAnalysisPrompt({ tasks: promptTasks, today: todayIso() })

  // The slow step: one Anthropic call that returns everything at once (~30–60s). Log it (so
  // launchd output and the terminal both show the wait) and spin so the run never looks stuck.
  logger.info(
    { tasks: promptTasks.length, model: config.model },
    'Analyzing tasks with the model — this usually takes 30–60s…',
  )
  const analyzeSpinner = createProgress({
    enabled: spinnersEnabled,
    label: `Analyzing ${promptTasks.length} tasks with ${config.model}… (~30–60s)`,
  })
  let result: AnalyzeResult
  try {
    result = await analyzer.analyze({ prompt, taskCount: promptTasks.length })
  } catch (err) {
    analyzeSpinner.fail('Analysis failed')
    throw err
  }
  const { analyses, latencyMs, inputTokens, outputTokens } = result
  analyzeSpinner.succeed(`Analyzed ${analyses.length} tasks in ${Math.round(latencyMs / 1000)}s`)
  logger.info(
    { tasks: tasks.length, analyses: analyses.length, latencyMs, inputTokens, outputTokens },
    'Analyzed tasks.',
  )

  const { items, unmatched } = joinAnalyses({ analyses, enriched })
  if (unmatched > 0) {
    logger.warn({ unmatched }, 'Some analyses did not match a task by index; dropping them.')
  }
  const unanalyzed = tasks.length - items.length
  if (unanalyzed > 0) {
    logger.warn(
      { unanalyzed, total: tasks.length },
      'Some tasks received no analysis; they are absent from this digest.',
    )
  }

  const digest = buildDigest({
    items,
    maxItems: config.digestMaxItems,
    staleThresholdDays: config.staleThresholdDays,
  })
  logger.info(
    { flaggedCount: digest.flaggedCount, totalStalled: digest.totalStalled },
    'Built digest.',
  )

  const today = todayIso()
  const shownSet = new Set<DigestItem>(digest.shown)
  appendRunLog({
    entries: items.map(item =>
      toRunLogEntry({ item, shown: shownSet.has(item), dryRun: opts.dryRun, now, today }),
    ),
    today,
    ...(runsDir !== undefined ? { dir: runsDir } : {}),
  })

  if (digest.flaggedCount === 0) {
    logger.info({ totalStalled: digest.totalStalled }, 'Nothing actionable right now; no email.')

    return { kind: 'no_actionable', totalStalled: digest.totalStalled }
  }

  if (opts.dryRun) {
    return {
      kind: 'dry_run',
      subject: digest.subject,
      body: digest.body,
      flaggedCount: digest.flaggedCount,
      totalStalled: digest.totalStalled,
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
  logger.info({ messageId: sent.id, flaggedCount: digest.flaggedCount }, 'Digest sent.')

  return {
    kind: 'sent',
    messageId: sent.id,
    flaggedCount: digest.flaggedCount,
    totalStalled: digest.totalStalled,
  }
}

// Joins each analysis back to its task by index (the model echoes the task's input position).
// Index matching is robust to the model paraphrasing the title; an out-of-range or duplicate
// index is counted and dropped rather than mis-joined.
function joinAnalyses({ analyses, enriched }: { analyses: TaskAnalysis[]; enriched: Enriched[] }): {
  items: DigestItem[]
  unmatched: number
} {
  const items: DigestItem[] = []
  const seen = new Set<number>()
  let unmatched = 0
  for (const analysis of analyses) {
    const match = enriched[analysis.index]
    if (!match || seen.has(analysis.index)) {
      unmatched += 1
      continue
    }
    seen.add(analysis.index)
    items.push({
      title: match.task.title,
      list: match.task.list,
      classification: analysis.classification,
      reasoning: analysis.reasoning,
      suggestedNextAction: analysis.suggested_next_action,
      priority: analysis.priority,
      staleDays: match.staleDays,
      dueStatus: match.dueStatus,
    })
  }

  return { items, unmatched }
}

function toRunLogEntry({
  item,
  shown,
  dryRun,
  now,
  today,
}: {
  item: DigestItem
  shown: boolean
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
    priority: item.priority,
    stale_days: item.staleDays,
    due_status: item.dueStatus,
    suggested_next_action: item.suggestedNextAction,
    shown,
  }
}
