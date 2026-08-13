import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import pino from 'pino'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Config } from '../config.js'
import { fingerprintOf, touchKey } from '../state/touch-clock.js'
import { type AlertResult, runAlert } from './alert.js'
import { readOpenTasks } from './task-io.js'

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json'
const NOW = new Date(2026, 7, 20, 8, 0)
// 31 calendar days before NOW, past the 28-day horizon.
const LONG_QUIET = new Date(2026, 6, 20, 8, 0)
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

function readTodos(): string {
  return readFileSync(join(vaultPath, TODOS_FILE), 'utf8')
}

// Stamps the tasks in the file as last touched on a given day, read through the same scanner the
// run uses so identities and fingerprints match. Without it every task reads as touched today.
async function seedClock({
  lastTouched,
  titles,
}: {
  lastTouched: Date
  titles?: string[]
}): Promise<void> {
  const open = await readOpenTasks({ vaultPath, scopes: SCOPES })
  const wanted = titles ? open.filter(task => titles.includes(task.title)) : open
  const seeded = Object.fromEntries(
    wanted.map(task => [
      touchKey({ list: task.list, title: task.title }),
      { fingerprint: fingerprintOf(task.raw), lastTouched: lastTouched.toISOString() },
    ]),
  )
  const stored = existsSync(clockPath) ? readClock().tasks : {}
  writeFileSync(clockPath, JSON.stringify({ version: 1, tasks: { ...stored, ...seeded } }))
}

function readClock(): { tasks: Record<string, { fingerprint: string; lastTouched: string }> } {
  return JSON.parse(readFileSync(clockPath, 'utf8')) as {
    tasks: Record<string, { fingerprint: string; lastTouched: string }>
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    toEmail: 'me@example.com',
    wipCap: 3,
    stallDays: 7,
    horizonDays: 28,
    doneWindowDays: 7,
    overrideWindowDays: 30,
    overrideLimit: 3,
    taskLists: SCOPES,
    obsidianVaultPath: vaultPath,
    model: 'claude-sonnet-5',
    anthropicApiKey: 'test-anthropic-key',
    gmailClientId: 'cid',
    gmailClientSecret: 'secret',
    gmailRefreshToken: 'rtok',
    dueAlertDays: 7,
    alertUrl: 'obsidian://open?vault=iphone&file=Todos/Dashboard.md',
    pushoverToken: 'app-token',
    pushoverUserKey: 'user-key',
    ...overrides,
  }
}

function run(overrides: { config?: Config; dryRun?: boolean } = {}): Promise<AlertResult> {
  return runAlert({
    config: overrides.config ?? makeConfig(),
    scopes: SCOPES,
    opts: { dryRun: overrides.dryRun ?? true },
    now: NOW,
    clockPath,
    logger: silentLogger,
  })
}

function captureSend(): { body: () => Record<string, string> } {
  let received: Record<string, string> = {}
  server.use(
    http.post(PUSHOVER_URL, async ({ request }) => {
      received = Object.fromEntries(new URLSearchParams(await request.text()))

      return HttpResponse.json({ status: 1, request: 'req-1' })
    }),
  )

  return { body: () => received }
}

// No handler is registered in the silent cases: a POST would fail the test through msw.
it('pushes nothing when nothing is due and nothing decayed', async () => {
  writeTodos(['- [ ] book india flights #active', '- [ ] water the plants 📅 2026-08-25'])

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
})

it('pushes nothing about a task that was already ticked', async () => {
  writeTodos(['- [x] give Dolly her meds 🔁 every day 📅 2026-08-19 ✅ 2026-08-19'])

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
})

it('lists what is due, most overdue first', async () => {
  writeTodos([
    '- [ ] water the schefflera 🔁 every week 📅 2026-08-20',
    '- [ ] give Dolly her meds 🔁 every day 📅 2026-08-18',
  ])

  const result = await run()

  expect(result).toMatchObject({ kind: 'dry_run', dueCount: 2, demotedCount: 0 })
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result.title).toBe('Due or overdue (2)')
  expect(result.message).toBe('• give Dolly her meds\n• water the schefflera')
})

// Putting a date on something is the reason to want reminding of it, whatever pool it sits in.
it('alerts on a dated #someday task', async () => {
  writeTodos(['- [ ] renew the passport #someday 📅 2026-08-20'])

  expect(await run()).toMatchObject({ kind: 'dry_run', dueCount: 1 })
})

it('sends the push with the deep link and normal priority', async () => {
  writeTodos(['- [ ] give Dolly her meds 🔁 every day 📅 2026-08-20'])
  const sent = captureSend()

  const result = await run({ dryRun: false })

  expect(result).toEqual({ kind: 'sent', requestId: 'req-1', dueCount: 1, demotedCount: 0 })
  expect(sent.body()).toMatchObject({
    title: 'Due today (1)',
    message: '• give Dolly her meds',
    url: 'obsidian://open?vault=iphone&file=Todos/Dashboard.md',
    priority: '0',
  })
})

// The machine is dropping a commitment the user did not drop, so the push says so even on a day
// with nothing due, and the tag is rewritten rather than the box being closed.
it('demotes a task nothing has touched for the horizon and announces it', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: LONG_QUIET })
  const sent = captureSend()

  const result = await run({ dryRun: false })

  expect(result).toMatchObject({ kind: 'sent', dueCount: 0, demotedCount: 1 })
  expect(readTodos()).toContain('- [ ] book india flights #someday')
  expect(sent.body()).toMatchObject({
    title: 'Moved to someday (1)',
    message: 'Moved to someday:\n• book india flights, untouched 31 days',
  })
})

// The demotion is this app's own edit, so the age it was judging has to survive it. Without the
// fingerprint update the next pass would read the rewritten line as work the user did.
it('keeps the demoted task at the age it decayed at', async () => {
  writeTodos(['- [ ] book india flights #active'])
  await seedClock({ lastTouched: LONG_QUIET })
  captureSend()

  await run({ dryRun: false })

  const key = touchKey({ list: 'todos', title: 'book india flights' })
  const entry = readClock().tasks[key]
  expect(entry?.lastTouched).toBe(LONG_QUIET.toISOString())
  expect(entry?.fingerprint).toBe(fingerprintOf('- [ ] book india flights #someday'))
})

// Three tasks equally stale, so only decay's own state/recurrence check can be what protects the
// first two. The third carries neither exemption, so it decays same as any other #active task.
it('leaves a #someday task and a recurring task alone, but still decays a plain #active one', async () => {
  writeTodos([
    '- [ ] hang the shelf #someday',
    '- [ ] water the schefflera 🔁 every week #active',
    '- [ ] fix the gate #active',
  ])
  await seedClock({ lastTouched: LONG_QUIET })

  expect(await run()).toMatchObject({ kind: 'dry_run', dueCount: 0, demotedCount: 1 })
  expect(readTodos()).toContain('- [ ] hang the shelf #someday')
  expect(readTodos()).toContain('- [ ] water the schefflera 🔁 every week #active')
  expect(readTodos()).toContain('- [ ] fix the gate #someday')
})

// Two state tags on one line is a contradiction nothing here resolves, so the task has no state at
// all and never counts as active. The push leaves it exactly where it is.
it('leaves a line carrying two state tags alone', async () => {
  writeTodos(['- [ ] book india flights #active #someday'])
  await seedClock({ lastTouched: LONG_QUIET })

  expect(await run()).toEqual({ kind: 'silent', reason: 'nothing_due' })
  expect(readTodos()).toContain('- [ ] book india flights #active #someday')
})

// The alert half reads the due date and ignores the state tag; the decay half reads neither. A task
// that satisfies both is named in both halves of the same push.
it('reports a task that is both due and decayed in both halves', async () => {
  writeTodos(['- [ ] fix the gate #active 📅 2026-08-18'])
  await seedClock({ lastTouched: LONG_QUIET })

  const result = await run()

  expect(result).toMatchObject({ kind: 'dry_run', dueCount: 1, demotedCount: 1 })
  if (result.kind !== 'dry_run') throw new Error('expected dry_run')
  expect(result.title).toBe('Due or overdue (1)')
  expect(result.message).toContain('• fix the gate\n')
  expect(result.message).toContain('• fix the gate, untouched 31 days')
  expect(readTodos()).toContain('- [ ] fix the gate #someday 📅 2026-08-18')
})

it('fails the run when Pushover refuses, rather than reporting a push nobody got', async () => {
  writeTodos(['- [ ] give Dolly her meds 🔁 every day 📅 2026-08-20'])
  server.use(
    http.post(PUSHOVER_URL, () =>
      HttpResponse.json({ status: 0, errors: ['user key is invalid'] }, { status: 400 }),
    ),
  )

  await expect(run({ dryRun: false })).rejects.toThrow(/Pushover refused/)
})
