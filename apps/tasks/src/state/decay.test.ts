import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decayed, hasDecayed } from './decay.js'
import type { CapCandidate } from './wip.js'

// Decay is counted in local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)
const HORIZON_DAYS = 28

function candidate(overrides: Partial<CapCandidate> = {}): CapCandidate {
  return {
    title: 'book india flights',
    list: 'todos',
    status: 'open',
    isRecurring: false,
    state: 'active',
    due: null,
    lastTouched: new Date(2026, 6, 23),
    ...overrides,
  }
}

describe('hasDecayed', () => {
  it('demotes an #active task untouched for the whole horizon', () => {
    expect(hasDecayed({ task: candidate(), horizonDays: HORIZON_DAYS, now: NOW })).toBe(true)
  })

  it('leaves a task touched one day inside the horizon alone', () => {
    const task = candidate({ lastTouched: new Date(2026, 6, 24) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a #someday task alone however long it sits', () => {
    const task = candidate({ state: 'someday', lastTouched: new Date(2026, 0, 1) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a recurring task alone', () => {
    const task = candidate({ isRecurring: true, lastTouched: new Date(2026, 0, 1) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a closed task alone', () => {
    const task = candidate({ status: 'done', lastTouched: new Date(2026, 0, 1) })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })

  // A deleted clock must not demote everything at once.
  it('treats an unknown age as no evidence', () => {
    const task = candidate({ lastTouched: undefined })

    expect(hasDecayed({ task, horizonDays: HORIZON_DAYS, now: NOW })).toBe(false)
  })
})

describe('decayed', () => {
  it('keeps only the tasks past the horizon', () => {
    const tasks = [
      candidate({ title: 'book india flights' }),
      candidate({ title: 'fix the gate', lastTouched: new Date(2026, 7, 19) }),
    ]

    expect(decayed({ tasks, horizonDays: HORIZON_DAYS, now: NOW }).map(task => task.title)).toEqual(
      ['book india flights'],
    )
  })
})
