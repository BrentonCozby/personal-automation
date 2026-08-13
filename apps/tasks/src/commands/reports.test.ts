import { expect, it } from 'vitest'
import type { AbandonResult } from './abandon.js'
import type { PromoteResult } from './promote.js'
import { renderAbandonResult, renderPromoteResult, renderScheduleResult } from './reports.js'
import type { ScheduleResult } from './schedule.js'

// Local-time constructors throughout: every phrase here counts calendar days, so a UTC instant
// would land on a different date depending on the machine's zone.
const NOW = new Date(2026, 7, 14, 9, 0)

function render(result: PromoteResult): string {
  return renderPromoteResult({ result, now: NOW })
}

it('names the tasks holding the cap and the order they are in', () => {
  const text = render({
    kind: 'at_cap',
    cap: 3,
    active: [
      {
        title: 'fix the bike',
        list: 'todos',
        lastTouched: new Date(2026, 7, 13, 9, 0),
        due: new Date(2026, 7, 20),
      },
      { title: 'file taxes', list: 'todos', lastTouched: undefined, due: null },
    ],
  })

  expect(text).toContain('2 tasks are already #active, which is the cap.')
  expect(text).toContain('most recently touched, then soonest due')
  expect(text).toContain('1. fix the bike — touched yesterday, due 2026-08-20')
  expect(text).toContain('2. file taxes — not touched since the clock started')
  expect(text).toContain('--over-cap to make it 4 this once')
})

it('reads a task touched today as touched today', () => {
  const text = render({
    kind: 'at_cap',
    cap: 1,
    active: [
      { title: 'fix the bike', list: 'todos', lastTouched: new Date(NOW.getTime()), due: null },
    ],
  })

  expect(text).toContain('touched today')
  expect(text).toContain('1 task is already #active')
})

it('counts days rather than hours', () => {
  const text = render({
    kind: 'at_cap',
    cap: 1,
    active: [
      {
        title: 'fix the bike',
        list: 'todos',
        lastTouched: new Date(2026, 7, 9, 23, 0),
        due: null,
      },
    ],
  })

  expect(text).toContain('touched 5 days ago')
})

it('states the count against the cap on a promotion', () => {
  expect(
    render({
      kind: 'promoted',
      title: 'fix the bike',
      list: 'todos',
      activeCount: 2,
      cap: 3,
      isOverCap: false,
    }),
  ).toBe('Promoted "fix the bike" to #active — 2 of 3 active.')
})

// Raising the cap is a supported move: no warning, no scolding, just what happened.
it('states an over-cap promotion plainly', () => {
  const text = render({
    kind: 'promoted',
    title: 'fix the bike',
    list: 'todos',
    activeCount: 4,
    cap: 3,
    isOverCap: true,
  })

  expect(text).toContain('4 active, one over the cap of 3')
  expect(text).toContain('runs/overrides.jsonl')
})

it('lists the tasks an ambiguous query matched', () => {
  const text = render({
    kind: 'ambiguous',
    query: 'fix',
    matches: [
      { title: 'fix the bike', list: 'todos', lastTouched: undefined, due: null },
      { title: 'fix the sink', list: 'home', lastTouched: undefined, due: null },
    ],
  })

  expect(text).toContain('"fix" matches 2 open tasks:')
  expect(text).toContain('fix the bike (todos)')
  expect(text).toContain('fix the sink (home)')
})

it('says where a missing task was looked for', () => {
  expect(render({ kind: 'not_found', query: 'kayak' })).toContain('TASK_LISTS')
})

it('explains that a recurring task is outside the model', () => {
  const text = render({ kind: 'not_editable', title: 'water plants', reason: 'recurring' })

  expect(text).toContain('recurring')
  expect(text).toContain('Nothing was changed.')
})

it('names the terminal tag it refused to move', () => {
  const text = render({
    kind: 'not_editable',
    title: 'gave up on this',
    reason: 'terminal',
    state: 'abandoned',
  })

  expect(text).toContain('#abandoned')
})

it('says an already-active task needs nothing', () => {
  expect(render({ kind: 'already_active', title: 'fix the bike' })).toBe(
    '"fix the bike" is already #active. Nothing to change.',
  )
})

it('tells you to run again after a conflict', () => {
  const text = render({ kind: 'conflict', title: 'fix the bike', path: 'Todos/todos.md' })

  expect(text).toContain('Todos/todos.md')
  expect(text).toContain('Run it again')
})

// Dropping something is the outcome this system is for, so it is stated as a plain result rather
// than an apology.
it('states an abandonment and what it freed', () => {
  const abandoned: AbandonResult = {
    kind: 'abandoned',
    title: 'fix the bike',
    list: 'todos',
    date: '2026-08-12',
    wasActive: true,
  }

  expect(renderAbandonResult(abandoned)).toBe(
    'Dropped "fix the bike" — its checkbox is cancelled and dated 2026-08-12.\nThat frees a place on the active list.',
  )
})

it('says nothing about the active list when the task was not on it', () => {
  const text = renderAbandonResult({
    kind: 'abandoned',
    title: 'fix the bike',
    list: 'todos',
    date: '2026-08-12',
    wasActive: false,
  })

  expect(text).not.toContain('active list')
})

it('shares the lookup failures across commands', () => {
  const notFound: ScheduleResult = { kind: 'not_found', query: 'kayak' }

  expect(renderScheduleResult(notFound)).toContain('TASK_LISTS')
  expect(renderAbandonResult({ kind: 'not_found', query: 'kayak' })).toContain('TASK_LISTS')
})

it('states a scheduling', () => {
  const scheduled: ScheduleResult = {
    kind: 'scheduled',
    title: 'fix the bike',
    list: 'todos',
    date: '2026-08-20',
    isDeferred: false,
    horizonDays: 28,
  }

  expect(renderScheduleResult(scheduled)).toBe('Scheduled "fix the bike" for 2026-08-20.')
})

it('explains a date past the horizon as a move, not a refusal', () => {
  const text = renderScheduleResult({
    kind: 'scheduled',
    title: 'fix the bike',
    list: 'todos',
    date: '2026-11-01',
    isDeferred: true,
    horizonDays: 28,
  })

  expect(text).toContain('past the 28-day horizon')
  expect(text).toContain('#someday')
})

it('names both date formats when the date will not parse', () => {
  const text = renderScheduleResult({ kind: 'bad_date', input: '2026-02-30' })

  expect(text).toContain('YYYY-MM-DD')
  expect(text).toContain('+7d')
})

it('says a past date has gone by', () => {
  const text = renderScheduleResult({ kind: 'past_date', input: '2026-08-01', date: '2026-08-01' })

  expect(text).toContain('2026-08-01 has already gone by')
})

// This is the message that would have caught three hand-added #active tags reading as #someday.
it('names both tags, the line, and what to do about a contradiction', () => {
  const text = render({
    kind: 'not_editable',
    title: 'condition leather shoes',
    reason: 'conflicting',
    states: ['someday', 'active'],
    path: 'Todos/todos.md',
    line: 11,
  })

  expect(text).toContain('#someday and #active')
  expect(text).toContain('Todos/todos.md:11')
  expect(text).toContain('counts as')
  expect(text).toContain('Delete the tag you did not mean')
})
