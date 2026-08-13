import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { lastTouchedOf, readTouchClock, touchKey } from '../state/touch-clock.js'
import { type PromoteResult, runPromote } from './promote.js'

const MONDAY = new Date('2026-08-10T09:00:00.000Z')
const FRIDAY = new Date('2026-08-14T09:00:00.000Z')

let dir: string
let vaultPath: string
let clockPath: string
let runsDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tasks-promote-'))
  vaultPath = join(dir, 'vault')
  runsDir = join(dir, 'runs')
  clockPath = join(runsDir, 'touch-clock.json')
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

function promote({
  query,
  isOverCap = false,
  cap = 3,
  now = MONDAY,
}: {
  query: string
  isOverCap?: boolean
  cap?: number
  now?: Date
}): Promise<PromoteResult> {
  return runPromote({ vaultPath, scopes: [], query, cap, isOverCap, now, clockPath, runsDir })
}

it('tags an untagged task #active and leaves the rest of the file alone', async () => {
  await writeTodos(['# Todos', '- [ ] fix the bike', '- [ ] call mom'].join('\n'))
  const result = await promote({ query: 'bike' })

  expect(result).toMatchObject({ kind: 'promoted', title: 'fix the bike', activeCount: 1, cap: 3 })
  expect(await todos()).toBe(['# Todos', '- [ ] fix the bike #active', '- [ ] call mom'].join('\n'))
})

it('replaces the #someday tag rather than adding a second one', async () => {
  await writeTodos('- [ ] fix the bike #someday ➕ 2026-05-01')
  await promote({ query: 'bike' })

  expect(await todos()).toBe('- [ ] fix the bike #active ➕ 2026-05-01')
})

it('records the promotion as a touch straight away', async () => {
  await writeTodos('- [ ] fix the bike')
  await promote({ query: 'bike', now: FRIDAY })
  const clock = await readTouchClock(clockPath)

  expect(lastTouchedOf({ clock, key: touchKey({ list: 'todos', title: 'fix the bike' }) })).toEqual(
    FRIDAY,
  )
})

// The fingerprint stored at promotion has to match what the next scan computes, or the task would
// read as touched again on every run and could never stall.
it('leaves the promoted task unchanged on the next run', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] call mom'].join('\n'))
  await promote({ query: 'bike', now: MONDAY })
  await promote({ query: 'call mom', now: FRIDAY })
  const clock = await readTouchClock(clockPath)

  expect(lastTouchedOf({ clock, key: touchKey({ list: 'todos', title: 'fix the bike' }) })).toEqual(
    MONDAY,
  )
})

it('stamps a task whose text changed since the last run', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] call mom'].join('\n'))
  await promote({ query: 'bike', now: MONDAY })
  await writeTodos(['- [ ] fix the bike #active', '- [ ] call mom 📅 2026-09-01'].join('\n'))
  await promote({ query: 'nothing matches this', now: FRIDAY })
  const clock = await readTouchClock(clockPath)

  expect(lastTouchedOf({ clock, key: touchKey({ list: 'todos', title: 'call mom' }) })).toEqual(
    FRIDAY,
  )
})

it('refuses at the cap, naming the active tasks and the order', async () => {
  await writeTodos(
    [
      '- [ ] one #active 📅 2026-09-01',
      '- [ ] two #active 📅 2026-08-20',
      '- [ ] three #active',
      '- [ ] four',
    ].join('\n'),
  )
  const result = await promote({ query: 'four' })

  expect(result).toMatchObject({ kind: 'at_cap', cap: 3 })
  // Every task is touched now on a cold start, so the due date breaks all three ties.
  expect(result.kind === 'at_cap' && result.active.map(task => task.title)).toEqual([
    'two',
    'one',
    'three',
  ])
  expect(await todos()).toContain('- [ ] four')
  expect(await todos()).not.toContain('four #active')
})

it('does not count a recurring task toward the cap', async () => {
  await writeTodos(
    [
      '- [ ] one #active',
      '- [ ] two #active',
      '- [ ] water plants #active 🔁 every week',
      '- [ ] four',
    ].join('\n'),
  )
  const result = await promote({ query: 'four' })

  expect(result.kind).toBe('promoted')
})

it('promotes past the cap with --over-cap and records the override', async () => {
  await writeTodos(
    ['- [ ] one #active', '- [ ] two #active', '- [ ] three #active', '- [ ] four'].join('\n'),
  )
  const result = await promote({ query: 'four', isOverCap: true, now: FRIDAY })

  expect(result).toMatchObject({ kind: 'promoted', activeCount: 4, isOverCap: true })
  expect(await todos()).toContain('- [ ] four #active')
  expect(await readFile(join(runsDir, 'overrides.jsonl'), 'utf8')).toBe(
    `${JSON.stringify({
      timestamp: FRIDAY.toISOString(),
      title: 'four',
      list: 'todos',
      cap: 3,
      active_count: 3,
    })}\n`,
  )
})

it('records no override when --over-cap was passed but the cap had room', async () => {
  await writeTodos('- [ ] fix the bike')
  const result = await promote({ query: 'bike', isOverCap: true })

  expect(result).toMatchObject({ kind: 'promoted', isOverCap: false })
  await expect(readFile(join(runsDir, 'overrides.jsonl'), 'utf8')).rejects.toThrow()
})

it('reports no match', async () => {
  await writeTodos('- [ ] fix the bike')

  expect(await promote({ query: 'kayak' })).toEqual({ kind: 'not_found', query: 'kayak' })
})

it('reports every match rather than guessing between them', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] fix the bike brake'].join('\n'))
  const result = await promote({ query: 'fix' })

  expect(result.kind).toBe('ambiguous')
  expect(result.kind === 'ambiguous' && result.matches.map(match => match.title)).toEqual([
    'fix the bike',
    'fix the bike brake',
  ])
  expect(await todos()).not.toContain('#active')
})

// Without this, a task whose whole title sits inside a longer one could never be named on its own.
it('takes an exact title over the longer task that contains it', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] fix the bike brake'].join('\n'))
  const result = await promote({ query: 'fix the bike' })

  expect(result).toMatchObject({ kind: 'promoted', title: 'fix the bike' })
})

it('matches without regard to case', async () => {
  await writeTodos('- [ ] Fix The Bike')

  expect(await promote({ query: 'fix the bike' })).toMatchObject({ kind: 'promoted' })
})

it('refuses a recurring task, which lives outside the state model', async () => {
  await writeTodos('- [ ] water plants 🔁 every week')
  const result = await promote({ query: 'water' })

  expect(result).toEqual({ kind: 'not_editable', title: 'water plants', reason: 'recurring' })
  expect(await todos()).not.toContain('#active')
})

it('refuses a task in a terminal state', async () => {
  await writeTodos('- [ ] gave up on this #abandoned')
  const result = await promote({ query: 'gave up' })

  expect(result).toMatchObject({ kind: 'not_editable', reason: 'terminal', state: 'abandoned' })
})

it('says nothing needs doing when the task is already active', async () => {
  await writeTodos('- [ ] fix the bike #active')
  const result = await promote({ query: 'bike' })

  expect(result).toEqual({ kind: 'already_active', title: 'fix the bike' })
})

it('does not match a completed task', async () => {
  await writeTodos('- [x] fix the bike ✅ 2026-08-01')

  expect(await promote({ query: 'bike' })).toMatchObject({ kind: 'not_found' })
})

// Adding #active by hand in Obsidian leaves the old tag in place, and the write path clears every
// state tag before writing, so acting here would silently throw away whichever was not meant.
it('refuses a task carrying two state tags and names the line', async () => {
  await writeTodos(['# Todos', '- [ ] fix the bike #someday #active ➕ 2026-05-01'].join('\n'))
  const result = await promote({ query: 'bike' })

  expect(result).toMatchObject({
    kind: 'not_editable',
    reason: 'conflicting',
    states: ['someday', 'active'],
    path: 'todos.md',
    line: 2,
  })
  expect(await todos()).toBe(
    ['# Todos', '- [ ] fix the bike #someday #active ➕ 2026-05-01'].join('\n'),
  )
})

// It is in neither state, so it holds no place on the active list and sits in no holding pool.
it('counts a contradictory task toward neither the cap nor anything else', async () => {
  await writeTodos(['- [ ] one #someday #active', '- [ ] two #active', '- [ ] three'].join('\n'))
  const result = await promote({ query: 'three', cap: 2 })

  expect(result).toMatchObject({ kind: 'promoted', activeCount: 2 })
})
