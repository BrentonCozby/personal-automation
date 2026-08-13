import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isStalled, untouchedDays } from './stall.js'
import type { CapCandidate } from './wip.js'

// Stalling is counted in local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)

function candidate(overrides: Partial<CapCandidate> = {}): CapCandidate {
  return {
    title: 'a task',
    list: 'todos',
    status: 'open',
    isRecurring: false,
    state: 'active',
    due: null,
    lastTouched: new Date(2026, 7, 13),
    ...overrides,
  }
}

describe('untouchedDays', () => {
  it('counts the calendar days since the last touch', () => {
    const task = candidate({ lastTouched: new Date(2026, 7, 13, 23, 30) })

    expect(untouchedDays({ task, now: NOW })).toBe(7)
  })

  it('is zero on the day of the touch', () => {
    const task = candidate({ lastTouched: new Date(2026, 7, 20, 1, 0) })

    expect(untouchedDays({ task, now: NOW })).toBe(0)
  })

  it('is undefined when the clock has never seen the task', () => {
    expect(untouchedDays({ task: candidate({ lastTouched: undefined }), now: NOW })).toBeUndefined()
  })
})

describe('isStalled', () => {
  it('stalls on the day the window closes', () => {
    const task = candidate({ lastTouched: new Date(2026, 7, 13) })

    expect(isStalled({ task, stallDays: 7, now: NOW })).toBe(true)
  })

  it('does not stall a day short of the window', () => {
    const task = candidate({ lastTouched: new Date(2026, 7, 14) })

    expect(isStalled({ task, stallDays: 7, now: NOW })).toBe(false)
  })

  // A date in the future means the task is scheduled, and the Tasks plugin surfaces it on the day.
  it('does not stall a task due in the future', () => {
    const task = candidate({ lastTouched: new Date(2026, 6, 1), due: new Date(2026, 7, 25) })

    expect(isStalled({ task, stallDays: 7, now: NOW })).toBe(false)
  })

  it('stalls a task whose due date has passed', () => {
    const task = candidate({ lastTouched: new Date(2026, 6, 1), due: new Date(2026, 7, 10) })

    expect(isStalled({ task, stallDays: 7, now: NOW })).toBe(true)
  })

  it('stalls a task due today', () => {
    const task = candidate({ lastTouched: new Date(2026, 6, 1), due: new Date(2026, 7, 20) })

    expect(isStalled({ task, stallDays: 7, now: NOW })).toBe(true)
  })

  it('only stalls what the cap counts', () => {
    const untouched = { lastTouched: new Date(2026, 6, 1) }

    expect(
      isStalled({ task: candidate({ ...untouched, state: 'someday' }), stallDays: 7, now: NOW }),
    ).toBe(false)
    expect(
      isStalled({ task: candidate({ ...untouched, state: undefined }), stallDays: 7, now: NOW }),
    ).toBe(false)
    expect(
      isStalled({ task: candidate({ ...untouched, status: 'done' }), stallDays: 7, now: NOW }),
    ).toBe(false)
    expect(
      isStalled({ task: candidate({ ...untouched, isRecurring: true }), stallDays: 7, now: NOW }),
    ).toBe(false)
  })

  // Every open task is in the clock by the time this runs, so this is the belt-and-braces case: an
  // unknown age is not evidence of a stall, and reading it as one would nag on a cold start.
  it('does not stall a task the clock has never seen', () => {
    const task = candidate({ lastTouched: undefined })

    expect(isStalled({ task, stallDays: 7, now: NOW })).toBe(false)
  })
})
