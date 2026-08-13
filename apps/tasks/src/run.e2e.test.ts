import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import { decodeEmailBodies } from '@personal-automation/common/test-mime'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { GMAIL_API_BASE_URL, GOOGLE_OAUTH_TOKEN_URL } from '@personal-automation/gmail/constants'
import { HttpResponse, http } from 'msw'
import pino from 'pino'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { TasksAnalyzer } from './anthropic/client.js'
import type { TaskAnalysis } from './anthropic/schemas.js'
import { readOpenTasks } from './commands/task-io.js'
import type { Config } from './config.js'
import { type RunResult, runDigest } from './run.js'
import type { RunLogEntry } from './run-log.js'
import { fingerprintOf, touchKey } from './state/touch-clock.js'

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const NOW = new Date('2026-06-02T12:00:00Z')
// 32 calendar days before NOW, so a seeded task is well past the 7-day stall window.
const QUIET_SINCE = new Date('2026-05-01T12:00:00Z')
const TODOS_FILE = 'Todos/todos.md'
const SCOPES = [TODOS_FILE]
const silentLogger = pino({ level: 'silent' })

const server = setupMswServer()

let vaultPath: string
let runsDir: string
let clockPath: string

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), 'tasks-vault-'))
  runsDir = mkdtempSync(join(tmpdir(), 'tasks-runs-'))
  clockPath = join(runsDir, 'touch-clock.json')
  mkdirSync(join(vaultPath, 'Todos'))
})

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true })
  rmSync(runsDir, { recursive: true, force: true })
})

function writeTodos(lines: string[]): void {
  writeFileSync(join(vaultPath, TODOS_FILE), `# Todos\n\n${lines.join('\n')}\n`)
}

/**
 * Stamps the tasks currently in the file as last touched on a given day, reading them through the
 * same scanner the run uses so the identities and fingerprints match exactly. Without a seeded clock
 * every task reads as touched today, which is the cold start.
 *
 * `titles` narrows it to some of them; the rest are left for the run to stamp as touched now.
 */
async function seedClock({
  lastTouched,
  titles,
}: {
  lastTouched: Date
  titles?: string[]
}): Promise<void> {
  const open = await readOpenTasks({ vaultPath, scopes: SCOPES })
  const wanted = titles ? open.filter(task => titles.includes(task.title)) : open
  const tasks = Object.fromEntries(
    wanted.map(task => [
      touchKey({ list: task.list, title: task.title }),
      { fingerprint: fingerprintOf(task.raw), lastTouched: lastTouched.toISOString() },
    ]),
  )
  writeFileSync(clockPath, JSON.stringify({ version: 1, tasks }))
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    toEmail: 'me@example.com',
    wipCap: 3,
    stallDays: 7,
    horizonDays: 28,
    taskLists: SCOPES,
    obsidianVaultPath: vaultPath,
    model: 'claude-sonnet-5',
    anthropicApiKey: 'test-anthropic-key',
    gmailClientId: 'cid',
    gmailClientSecret: 'secret',
    gmailRefreshToken: 'rtok',
    ...overrides,
  }
}

function run(
  overrides: { config?: Config; dryRun?: boolean; analyzer?: TasksAnalyzer } = {},
): Promise<RunResult> {
  return runDigest({
    config: overrides.config ?? makeConfig(),
    scopes: SCOPES,
    opts: { dryRun: overrides.dryRun ?? true },
    now: NOW,
    clockPath,
    runsDir,
    logger: silentLogger,
    ...(overrides.analyzer ? { analyzer: overrides.analyzer } : {}),
  })
}

function analysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    index: 0,
    title: 'book india flights',
    classification: 'aversion',
    reasoning: 'vague verb hides a multi-step project',
    suggested_next_action: 'Text Heidi for date windows',
    ...overrides,
  }
}

// The SDK parses content[0].text against the zod schema and surfaces it as parsed_output.
function mockAnthropic(analyses: TaskAnalysis[]): void {
  server.use(
    http.post(ANTHROPIC_MESSAGES_URL, () =>
      HttpResponse.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ tasks: analyses }) }],
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    ),
  )
}

function readRunLog(): RunLogEntry[] {
  const entries: RunLogEntry[] = []
  for (const file of readdirSync(runsDir)) {
    if (!file.startsWith('run-')) continue
    for (const line of readFileSync(join(runsDir, file), 'utf8').split('\n')) {
      if (line.trim()) entries.push(JSON.parse(line) as RunLogEntry)
    }
  }

  return entries
}

function readClock(): { tasks: Record<string, { lastTouched: string }> } {
  return JSON.parse(readFileSync(clockPath, 'utf8')) as {
    tasks: Record<string, { lastTouched: string }>
  }
}

// Nothing committed to means nothing to report. A digest about not having chosen anything is the
// deficit feeling the model exists to prevent, so it stays silent — and never calls the model.
it('sends nothing when no task is #active', async () => {
  writeTodos(['- [ ] book india flights #someday', '- [ ] water the plants'])

  // No Anthropic or Gmail handler registered: either call would fail the test via msw.
  expect(await run()).toEqual({ kind: 'no_active' })
})

it('sends nothing when the #active tasks are all still being worked on', async () => {
  writeTodos(['- [ ] book india flights #active', '- [ ] fix the gate #active'])

  // No seeded clock, so this run cold starts it: both tasks read as touched today.
  expect(await run()).toEqual({ kind: 'nothing_stalled', activeCount: 2 })
})

it('sends nothing when the quiet task is scheduled for a day still ahead', async () => {
  writeTodos(['- [ ] book india flights #active 📅 2026-07-01'])
  await seedClock({ lastTouched: QUIET_SINCE })

  expect(await run()).toEqual({ kind: 'nothing_stalled', activeCount: 1 })
})

it('builds the digest for the quiet tasks only, and records them for tuning', async () => {
  writeTodos([
    '- [ ] book india flights #active',
    '- [ ] fix the gate #active',
    '- [ ] hang the shelf #someday',
  ])
  await seedClock({ lastTouched: QUIET_SINCE, titles: ['book india flights'] })
  mockAnthropic([analysis()])

  const result = await run()

  expect(result.kind).toBe('dry_run')
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result).toMatchObject({ quietCount: 1, activeCount: 2 })
  expect(result.subject).toBe('Task Review — 1 task has gone quiet')
  expect(result.body).toContain('book india flights · todos')
  expect(result.body).toContain('Start here →  Text Heidi for date windows')
  expect(result.body).toContain('1 of the 2 tasks you are carrying has gone quiet.')
  // The task that is still being worked on is not in the email, and never reached the model.
  expect(result.body).not.toContain('fix the gate')

  const log = readRunLog()
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({
    title: 'book india flights',
    list: 'todos',
    classification: 'aversion',
    untouched_days: 32,
    dry_run: true,
  })
})

// A task the model skipped is left out rather than shown with an invented reason, and the rest of
// the review still goes out.
it('leaves out a quiet task the model returned no analysis for', async () => {
  writeTodos(['- [ ] book india flights #active', '- [ ] fix the gate #active'])
  await seedClock({ lastTouched: QUIET_SINCE })
  mockAnthropic([analysis({ index: 1, title: 'fix the gate' })])

  const result = await run()

  expect(result).toMatchObject({ kind: 'dry_run', quietCount: 1, activeCount: 2 })
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result.body).toContain('fix the gate')
  expect(result.body).not.toContain('book india flights')
})

// Sending an empty email would be worse than silence, and reporting "nothing has gone quiet" would
// say the opposite of what happened. The run fails instead, so the failure is visible.
it('fails the run when the model returns nothing usable', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: QUIET_SINCE })
  mockAnthropic([])

  // No Gmail handler registered: a send attempt would fail the test via msw.
  await expect(run({ dryRun: false })).rejects.toThrow(/no usable analysis for 1 quiet task/)
})

it('fails the run when the model call fails, rather than sending a review with holes in it', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: QUIET_SINCE })
  const analyzer: TasksAnalyzer = {
    analyze: () => Promise.reject(new AppError({ message: 'Anthropic is overloaded.' })),
  }

  // No Gmail handler registered: a send attempt would fail the test via msw.
  await expect(run({ dryRun: false, analyzer })).rejects.toThrow(/overloaded/)
})

it('sends the digest via Gmail on a real (msw) send path', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: QUIET_SINCE })
  mockAnthropic([analysis()])
  let receivedRaw = ''
  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, () =>
      HttpResponse.json({ access_token: 'atok', expires_in: 3600, token_type: 'Bearer' }),
    ),
    http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
      receivedRaw = ((await request.json()) as { raw: string }).raw

      return HttpResponse.json({ id: 'msg-xyz', threadId: 'thr-xyz' })
    }),
  )

  const result = await run({ dryRun: false })

  expect(result).toEqual({ kind: 'sent', messageId: 'msg-xyz', quietCount: 1, activeCount: 1 })
  const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
  expect(decoded).toContain('To: me@example.com')
  expect(decodeEmailBodies(decoded)).toContain('book india flights')
})

// The digest is one of the things that ticks the clock, so an edit made between two edits of a task
// is noticed on the next review rather than never.
it('brings the touch clock up to date, and forgets a task that has been finished', async () => {
  // Seed from the file as it was, then edit it the way a month in Obsidian would: one task ticked
  // off, the other promoted.
  writeTodos(['- [ ] hang the shelf', '- [ ] book india flights'])
  await seedClock({ lastTouched: QUIET_SINCE })
  writeTodos(['- [x] hang the shelf ✅ 2026-05-30', '- [ ] book india flights #active'])

  await run()

  const clock = readClock()
  expect(Object.keys(clock.tasks)).toEqual([
    touchKey({ list: 'todos', title: 'book india flights' }),
  ])
  // The line no longer matches its stored fingerprint (the tag was added), so it reads as touched.
  expect(clock.tasks[touchKey({ list: 'todos', title: 'book india flights' })]?.lastTouched).toBe(
    NOW.toISOString(),
  )
})

it('propagates a vault-access failure instead of reporting an empty review', async () => {
  await expect(
    run({ config: makeConfig({ obsidianVaultPath: join(vaultPath, 'nope') }) }),
  ).rejects.toThrow(/Obsidian vault not found/)
})
