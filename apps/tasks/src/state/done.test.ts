import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClosedTask, closedSince, countMoved } from './done.js'
import type { CapCandidate } from './wip.js'

// The window is counted in local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)

function closed(overrides: Partial<ClosedTask> = {}): ClosedTask {
  return {
    title: 'pay the water bill',
    list: 'todos',
    status: 'done',
    closed: new Date(2026, 7, 18),
    ...overrides,
  }
}

function candidate(overrides: Partial<CapCandidate> = {}): CapCandidate {
  return {
    title: 'a task',
    list: 'todos',
    status: 'open',
    isRecurring: false,
    state: 'active',
    due: null,
    lastTouched: new Date(2026, 7, 18),
    ...overrides,
  }
}

describe('closedSince', () => {
  it('separates what was finished from what was dropped', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'paid the bill', status: 'done' }),
        closed({ title: 'garage remote', status: 'cancelled' }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished.map(task => task.title)).toEqual(['paid the bill'])
    expect(wins.dropped.map(task => task.title)).toEqual(['garage remote'])
  })

  it('puts the most recent first', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'older', closed: new Date(2026, 7, 15) }),
        closed({ title: 'newest', closed: new Date(2026, 7, 19) }),
        closed({ title: 'middle', closed: new Date(2026, 7, 17) }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished.map(task => task.title)).toEqual(['newest', 'middle', 'older'])
  })

  // Seven days means today and the six before it, so the heading can say "the last 7 days" and be
  // literally true.
  it('keeps the whole window and nothing older', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'oldest day in the window', closed: new Date(2026, 7, 14) }),
        closed({ title: 'the day before it', closed: new Date(2026, 7, 13) }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished.map(task => task.title)).toEqual(['oldest day in the window'])
  })

  // A recurring chore leaves one closed line per completion, so the same title can appear several
  // times in a week. Three identical lines is the same fact three times, and it reads as padding.
  it('collapses repeats of one task into a count on its most recent day', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'cook beans', closed: new Date(2026, 7, 15) }),
        closed({ title: 'cook beans', closed: new Date(2026, 7, 18) }),
        closed({ title: 'water the tree', closed: new Date(2026, 7, 17) }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished).toEqual([
      { title: 'cook beans', list: 'todos', closed: new Date(2026, 7, 18), times: 2 },
      { title: 'water the tree', list: 'todos', closed: new Date(2026, 7, 17), times: 1 },
    ])
  })

  // The count of what you finished is the number of times you finished something, not the number of
  // distinct titles.
  it('keeps every completion in the count even after collapsing', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'cook beans', closed: new Date(2026, 7, 15) }),
        closed({ title: 'cook beans', closed: new Date(2026, 7, 18) }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished).toHaveLength(1)
    expect(wins.finishedCount).toBe(2)
  })

  // Same title on two lists is two different tasks, the same rule the touch clock uses for identity.
  it('does not collapse the same title on two different lists', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'pay the bill', list: 'todos' }),
        closed({ title: 'pay the bill', list: 'Family' }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished).toHaveLength(2)
  })

  it('ignores open tasks and closed ones carrying no date', () => {
    const wins = closedSince({
      tasks: [
        closed({ title: 'still open', status: 'open', closed: null }),
        closed({ title: 'no date', status: 'done', closed: null }),
        closed({ title: 'unknown status', status: 'other', closed: new Date(2026, 7, 18) }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished).toEqual([])
    expect(wins.dropped).toEqual([])
  })

  // A closing date in the future is a typo or a hand edit, not a win yet.
  it('ignores a date in the future', () => {
    const wins = closedSince({
      tasks: [closed({ closed: new Date(2026, 7, 25) })],
      windowDays: 7,
      now: NOW,
    })

    expect(wins.finished).toEqual([])
  })
})

describe('countMoved', () => {
  it('counts the tasks touched inside the window', () => {
    const moved = countMoved({
      active: [
        candidate({ title: 'touched', lastTouched: new Date(2026, 7, 19) }),
        candidate({ title: 'quiet', lastTouched: new Date(2026, 7, 1) }),
      ],
      windowDays: 7,
      now: NOW,
    })

    expect(moved).toBe(1)
  })

  it('does not count a task the clock has never seen', () => {
    const moved = countMoved({
      active: [candidate({ lastTouched: undefined })],
      windowDays: 7,
      now: NOW,
    })

    expect(moved).toBe(0)
  })
})
