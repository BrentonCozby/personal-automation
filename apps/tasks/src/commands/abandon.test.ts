import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readTouchClock, touchKey } from '../state/touch-clock.js'
import { type AbandonResult, runAbandon } from './abandon.js'
import { type PromoteResult, runPromote } from './promote.js'

// Local noon, so the date the command stamps is the same day in every zone.
const TODAY = new Date(2026, 7, 12, 12, 0)

let dir: string
let vaultPath: string
let clockPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tasks-abandon-'))
  vaultPath = join(dir, 'vault')
  clockPath = join(dir, 'runs', 'touch-clock.json')
  await mkdir(vaultPath, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeTodos(content: string): Promise<void> {
  await writeFile(join(vaultPath, 'todos.md'), content)
}

async function todos(): Promise<string> {
  return await readFile(join(vaultPath, 'todos.md'), 'utf8')
}

function abandon(query: string): Promise<AbandonResult> {
  return runAbandon({ vaultPath, scopes: [], query, now: TODAY, clockPath })
}

it('cancels the checkbox and stamps the date', async () => {
  await writeTodos(['# Todos', '- [ ] fix the bike', '- [ ] call mom'].join('\n'))
  const result = await abandon('bike')

  expect(result).toEqual({
    kind: 'abandoned',
    title: 'fix the bike',
    list: 'todos',
    date: '2026-08-12',
    wasActive: false,
  })
  expect(await todos()).toBe(
    ['# Todos', '- [-] fix the bike ❌ 2026-08-12', '- [ ] call mom'].join('\n'),
  )
})

// The box is the record, so the tag would state the same fact a second time.
it('takes the state tag off on the way out', async () => {
  await writeTodos('- [ ] fix the bike #someday ➕ 2026-05-01')
  await abandon('bike')

  expect(await todos()).toBe('- [-] fix the bike ➕ 2026-05-01 ❌ 2026-08-12')
})

it('reports that an active task gave its place back', async () => {
  await writeTodos('- [ ] fix the bike #active')
  const result = await abandon('bike')

  expect(result).toMatchObject({ kind: 'abandoned', wasActive: true })
})

// A cancelled box stops counting the moment it closes, which is what makes this the way to make
// room without finishing anything.
it('frees the task from the cap', async () => {
  function promote(query: string): Promise<PromoteResult> {
    return runPromote({
      vaultPath,
      scopes: [],
      query,
      cap: 2,
      isOverCap: false,
      now: TODAY,
      clockPath,
    })
  }
  await writeTodos(['- [ ] one #active', '- [ ] two #active', '- [ ] three'].join('\n'))

  expect(await promote('three')).toMatchObject({ kind: 'at_cap' })

  await abandon('one')

  expect(await promote('three')).toMatchObject({ kind: 'promoted', activeCount: 2 })
})

it('drops the task from the touch clock once its box is closed', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] call mom'].join('\n'))
  await abandon('bike')
  // A second command reconciles the clock against what is still open.
  await abandon('nothing matches this')
  const clock = await readTouchClock(clockPath)

  expect(Object.keys(clock.tasks)).toEqual([touchKey({ list: 'todos', title: 'call mom' })])
})

it('refuses a recurring task rather than fighting the plugin for it', async () => {
  await writeTodos('- [ ] water plants 🔁 every week')
  const result = await abandon('water')

  expect(result).toEqual({ kind: 'not_editable', title: 'water plants', reason: 'recurring' })
  expect(await todos()).toBe('- [ ] water plants 🔁 every week')
})

it('refuses a task already in a terminal state', async () => {
  await writeTodos('- [ ] gave up on this #abandoned')
  const result = await abandon('gave up')

  expect(result).toMatchObject({ kind: 'not_editable', reason: 'terminal', state: 'abandoned' })
})

it('reports no match', async () => {
  await writeTodos('- [ ] fix the bike')

  expect(await abandon('kayak')).toEqual({ kind: 'not_found', query: 'kayak' })
})

it('reports every match rather than guessing between them', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] fix the bike brake'].join('\n'))
  const result = await abandon('fix')

  expect(result.kind).toBe('ambiguous')
  expect(await todos()).not.toContain('[-]')
})

it('does not match a task whose box is already closed', async () => {
  await writeTodos('- [x] fix the bike ✅ 2026-08-01')

  expect(await abandon('bike')).toMatchObject({ kind: 'not_found' })
})
