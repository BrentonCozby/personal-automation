import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { GMAIL_API_BASE_URL, GOOGLE_OAUTH_TOKEN_URL } from '@personal-automation/gmail/constants'
import { HttpResponse, http } from 'msw'
import pino from 'pino'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { TaskAnalysis } from './anthropic/schemas.js'
import type { Config } from './config.js'
import type { TaskSource } from './reminders/source.js'
import type { Task } from './reminders/types.js'
import { runStalledTasks } from './run.js'
import type { RunLogEntry } from './run-log.js'

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const NOW = new Date('2026-06-02T12:00:00Z')
const silentLogger = pino({ level: 'silent' })

const server = setupMswServer()

let runsDir: string

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'stalled-runs-'))
})

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    toEmail: 'me@example.com',
    digestMaxItems: 5,
    staleThresholdDays: 30,
    remindersLists: [],
    model: 'claude-sonnet-4-6',
    anthropicApiKey: 'test-anthropic-key',
    gmailClientId: 'cid',
    gmailClientSecret: 'secret',
    gmailRefreshToken: 'rtok',
    ...overrides,
  }
}

function fixtureTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'r1',
    title: 'book india flights',
    notes: null,
    created: new Date('2025-05-20T00:00:00Z'),
    lastModified: new Date('2026-01-01T00:00:00Z'),
    due: null,
    list: 'Family',
    ...overrides,
  }
}

function fakeSource(tasks: Task[]): TaskSource {
  return { list: () => Promise.resolve(tasks) }
}

function analysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    index: 0,
    title: 'book india flights',
    classification: 'aversion',
    reasoning: 'vague verb hides a multi-step project',
    suggested_next_action: 'Text Heidi for date windows',
    priority: 'medium',
    ...overrides,
  }
}

// The SDK parses content[0].text against the zod schema and surfaces it as parsed_output.
function anthropicResponse(analyses: TaskAnalysis[]): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify({ tasks: analyses }) }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 80 },
  }
}

function mockAnthropic(analyses: TaskAnalysis[]): void {
  server.use(
    http.post(ANTHROPIC_MESSAGES_URL, () => HttpResponse.json(anthropicResponse(analyses))),
  )
}

function readRunLog(): RunLogEntry[] {
  const lines: RunLogEntry[] = []
  for (const file of readdirSync(runsDir)) {
    for (const line of readFileSync(join(runsDir, file), 'utf8').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as RunLogEntry)
    }
  }

  return lines
}

it('dry-run builds the digest, sends no email, and records every task to the run log', async () => {
  mockAnthropic([
    analysis({ index: 0, title: 'book india flights', classification: 'aversion' }),
    analysis({
      index: 1,
      title: 'water the plants',
      classification: 'fine',
      suggested_next_action: null,
    }),
  ])

  const result = await runStalledTasks({
    config: makeConfig(),
    opts: { dryRun: true },
    now: NOW,
    source: fakeSource([
      fixtureTask({ id: 'a', title: 'book india flights' }),
      fixtureTask({ id: 'b', title: 'water the plants' }),
    ]),
    runsDir,
    logger: silentLogger,
  })

  expect(result.kind).toBe('dry_run')
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result.subject).toBe('Task Review — 1 flagged')
  expect(result.flaggedCount).toBe(1)
  // Title is labeled with its list (fixtureTask defaults to the Family list).
  expect(result.body).toContain('book india flights · Family')
  expect(result.body).toContain('Start here →  Text Heidi for date windows')
  // fine task is dropped from the action list...
  expect(result.body).not.toContain('water the plants')

  // ...but both tasks are recorded for tuning, with the dry-run flag and the shown marker.
  const log = readRunLog()
  expect(log).toHaveLength(2)
  expect(log.every(e => e.dry_run === true)).toBe(true)
  const flights = log.find(e => e.title === 'book india flights')
  expect(flights?.classification).toBe('aversion')
  expect(flights?.shown).toBe(true)
  expect(log.find(e => e.title === 'water the plants')?.shown).toBe(false)
})

it('joins on index even when the model paraphrases the title entirely', async () => {
  // The echoed title bears no resemblance to the reminder; index 0 still pairs them, and the
  // digest renders the reminder's own title (not the model's paraphrase).
  mockAnthropic([
    analysis({
      index: 0,
      title: 'a totally different paraphrase',
      classification: 'blocked',
      priority: 'medium',
    }),
  ])

  const result = await runStalledTasks({
    config: makeConfig(),
    opts: { dryRun: true },
    now: NOW,
    source: fakeSource([fixtureTask({ id: 'h', title: 'replace Heidi’s laptop screen' })]),
    runsDir,
    logger: silentLogger,
  })

  expect(result.kind).toBe('dry_run')
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result.flaggedCount).toBe(1)
  expect(result.body).toContain('replace Heidi’s laptop screen')
  expect(result.body).not.toContain('a totally different paraphrase')
})

it('sends the digest via Gmail on a real (msw) send path', async () => {
  mockAnthropic([analysis({ title: 'book india flights', priority: 'high' })])
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

  const result = await runStalledTasks({
    config: makeConfig(),
    opts: { dryRun: false },
    now: NOW,
    source: fakeSource([fixtureTask()]),
    runsDir,
    logger: silentLogger,
  })

  expect(result).toEqual({ kind: 'sent', messageId: 'msg-xyz', flaggedCount: 1, totalStalled: 1 })
  const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
  expect(decoded).toContain('To: me@example.com')
  expect(decoded).toContain('book india flights')
  // Subject carries an em dash, so the gmail client RFC 2047 encodes it; decode it back.
  const subjectLine = decoded.split('\r\n').find(l => l.startsWith('Subject: ')) ?? ''
  const b64 = subjectLine.replace('Subject: =?UTF-8?B?', '').replace('?=', '')
  expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Task Review — 1 flagged')
})

it('returns no_open_tasks (and never calls the model) when there are no reminders', async () => {
  const result = await runStalledTasks({
    config: makeConfig(),
    opts: { dryRun: false },
    now: NOW,
    source: fakeSource([]),
    runsDir,
    logger: silentLogger,
  })

  // No Anthropic handler registered: msw would error on an unexpected request.
  expect(result).toEqual({ kind: 'no_open_tasks' })
})

it('sends no email when nothing is actionable', async () => {
  mockAnthropic([analysis({ title: 'book india flights', classification: 'fine' })])

  const result = await runStalledTasks({
    config: makeConfig(),
    opts: { dryRun: false },
    now: NOW,
    source: fakeSource([fixtureTask()]),
    runsDir,
    logger: silentLogger,
  })

  // No Gmail handler registered: a send attempt would fail the test via msw.
  expect(result).toEqual({ kind: 'no_actionable', totalStalled: 0 })
})

it('propagates a Reminders-access failure instead of sending an empty digest', async () => {
  const source: TaskSource = {
    list: () =>
      Promise.reject(
        new AppError({ message: 'Could not read Apple Reminders: access not granted.' }),
      ),
  }

  await expect(
    runStalledTasks({
      config: makeConfig(),
      opts: { dryRun: false },
      now: NOW,
      source,
      runsDir,
      logger: silentLogger,
    }),
  ).rejects.toThrow(/access not granted/)
})
