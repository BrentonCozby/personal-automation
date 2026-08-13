import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { lastTouchedOf, readTouchClock, touchKey } from '../state/touch-clock.js'
import { runSchedule, type ScheduleResult } from './schedule.js'

// Local noon, so every date the command reads or writes is the same day in any zone.
const TODAY = new Date(2026, 7, 12, 12, 0)
const HORIZON_DAYS = 28

let dir: string
let vaultPath: string
let clockPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tasks-schedule-'))
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

function schedule({ query, date }: { query: string; date: string }): Promise<ScheduleResult> {
  return runSchedule({
    vaultPath,
    scopes: [],
    query,
    dateInput: date,
    horizonDays: HORIZON_DAYS,
    now: TODAY,
    clockPath,
  })
}

it('puts a due date on a task that has none', async () => {
  await writeTodos(['# Todos', '- [ ] fix the bike #active', '- [ ] call mom'].join('\n'))
  const result = await schedule({ query: 'bike', date: '2026-08-20' })

  expect(result).toEqual({
    kind: 'scheduled',
    title: 'fix the bike',
    list: 'todos',
    date: '2026-08-20',
    isDeferred: false,
    horizonDays: HORIZON_DAYS,
  })
  expect(await todos()).toBe(
    ['# Todos', '- [ ] fix the bike #active 📅 2026-08-20', '- [ ] call mom'].join('\n'),
  )
})

it('replaces a date already on the task', async () => {
  await writeTodos('- [ ] fix the bike #active 📅 2026-08-15')
  await schedule({ query: 'bike', date: '2026-08-20' })

  expect(await todos()).toBe('- [ ] fix the bike #active 📅 2026-08-20')
})

it('reads +Nd as days from today', async () => {
  await writeTodos('- [ ] fix the bike')
  const result = await schedule({ query: 'bike', date: '+7d' })

  expect(result).toMatchObject({ kind: 'scheduled', date: '2026-08-19' })
  expect(await todos()).toBe('- [ ] fix the bike 📅 2026-08-19')
})

// Naming a day inside the horizon is a commitment, so the task keeps its place on the active list.
it('leaves an active task active when the date is inside the horizon', async () => {
  await writeTodos('- [ ] fix the bike #active')
  await schedule({ query: 'bike', date: '+28d' })

  expect(await todos()).toContain('#active')
  expect(await todos()).not.toContain('#someday')
})

it('moves a task past the horizon to #someday and says so', async () => {
  await writeTodos('- [ ] fix the bike #active')
  const result = await schedule({ query: 'bike', date: '+29d' })

  expect(result).toMatchObject({ kind: 'scheduled', isDeferred: true, date: '2026-09-10' })
  expect(await todos()).toBe('- [ ] fix the bike #someday 📅 2026-09-10')
})

it('counts scheduling as a touch', async () => {
  await writeTodos('- [ ] fix the bike')
  await schedule({ query: 'bike', date: '2026-08-20' })
  const clock = await readTouchClock(clockPath)

  expect(lastTouchedOf({ clock, key: touchKey({ list: 'todos', title: 'fix the bike' }) })).toEqual(
    TODAY,
  )
})

// The stored fingerprint has to match what the next scan computes, or the task would read as
// touched again on every run and could never stall.
it('leaves the scheduled task unchanged on the next run', async () => {
  await writeTodos(['- [ ] fix the bike', '- [ ] call mom'].join('\n'))
  await schedule({ query: 'bike', date: '2026-08-20' })
  const first = await readTouchClock(clockPath)
  await schedule({ query: 'call mom', date: '2026-08-21' })
  const second = await readTouchClock(clockPath)
  const key = touchKey({ list: 'todos', title: 'fix the bike' })

  expect(second.tasks[key]).toEqual(first.tasks[key])
})

it('refuses a date that has gone by, and writes nothing', async () => {
  await writeTodos('- [ ] fix the bike')
  const result = await schedule({ query: 'bike', date: '2026-08-11' })

  expect(result).toEqual({ kind: 'past_date', input: '2026-08-11', date: '2026-08-11' })
  expect(await todos()).toBe('- [ ] fix the bike')
})

it('accepts today', async () => {
  await writeTodos('- [ ] fix the bike')

  expect(await schedule({ query: 'bike', date: '2026-08-12' })).toMatchObject({ kind: 'scheduled' })
})

it('refuses a day that does not exist', async () => {
  await writeTodos('- [ ] fix the bike')
  const result = await schedule({ query: 'bike', date: '2026-02-30' })

  expect(result).toEqual({ kind: 'bad_date', input: '2026-02-30' })
  expect(await todos()).toBe('- [ ] fix the bike')
})

it('refuses a recurring task, which the plugin dates itself', async () => {
  await writeTodos('- [ ] water plants 🔁 every week 📅 2026-08-15')
  const result = await schedule({ query: 'water', date: '2026-08-20' })

  expect(result).toEqual({ kind: 'not_editable', title: 'water plants', reason: 'recurring' })
  expect(await todos()).toContain('📅 2026-08-15')
})

it('reports no match', async () => {
  await writeTodos('- [ ] fix the bike')

  expect(await schedule({ query: 'kayak', date: '2026-08-20' })).toEqual({
    kind: 'not_found',
    query: 'kayak',
  })
})
