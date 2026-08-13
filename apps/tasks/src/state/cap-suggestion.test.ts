import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OverrideEntry } from '../overrides.js'
import { suggestCapRaise } from './cap-suggestion.js'

// The window is counted in local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)
const WINDOW = { windowDays: 30, limit: 3 }

function override(entry: Partial<OverrideEntry> = {}): OverrideEntry {
  return {
    timestamp: new Date(2026, 7, 19, 10, 0).toISOString(),
    title: 'a task',
    list: 'todos',
    cap: 3,
    active_count: 3,
    ...entry,
  }
}

function times({
  count,
  entry = {},
}: {
  count: number
  entry?: Partial<OverrideEntry>
}): OverrideEntry[] {
  return Array.from({ length: count }, () => override(entry))
}

describe('suggestCapRaise', () => {
  it('suggests nothing when the cap has never been raised', () => {
    expect(suggestCapRaise({ entries: [], cap: 3, now: NOW, ...WINDOW })).toBeUndefined()
  })

  it('suggests nothing at the limit', () => {
    expect(
      suggestCapRaise({ entries: times({ count: 3 }), cap: 3, now: NOW, ...WINDOW }),
    ).toBeUndefined()
  })

  it('suggests a raise past the limit', () => {
    const suggestion = suggestCapRaise({
      entries: times({ count: 4 }),
      cap: 3,
      now: NOW,
      ...WINDOW,
    })

    expect(suggestion).toEqual({ overrideCount: 4, windowDays: 30, suggestedCap: 4 })
  })

  // The rule this whole feature exists for: raising TASKS_WIP_CAP retires every entry recorded
  // against the old one, so acting on the suggestion is what silences it.
  it('ignores raises recorded against a different cap', () => {
    const entries = [
      ...times({ count: 4, entry: { cap: 3 } }),
      ...times({ count: 2, entry: { cap: 4 } }),
    ]

    expect(suggestCapRaise({ entries, cap: 4, now: NOW, ...WINDOW })).toBeUndefined()
  })

  it('counts a raise on the oldest day of the window', () => {
    const entries = times({
      count: 4,
      entry: { timestamp: new Date(2026, 6, 22, 23, 30).toISOString() },
    })

    expect(suggestCapRaise({ entries, cap: 3, now: NOW, ...WINDOW })?.overrideCount).toBe(4)
  })

  it('drops a raise the day before the window opens', () => {
    const entries = times({
      count: 4,
      entry: { timestamp: new Date(2026, 6, 21, 23, 30).toISOString() },
    })

    expect(suggestCapRaise({ entries, cap: 3, now: NOW, ...WINDOW })).toBeUndefined()
  })

  /**
   * `active_count` is what was already active when the cap was raised, so one more than the largest
   * of them is the most you actually chose to carry. Suggesting `cap + 1` after a run at six would
   * argue with the system's own record.
   */
  it('suggests one more than the most that was ever carried', () => {
    const entries = [
      ...times({ count: 2, entry: { active_count: 3 } }),
      override({ active_count: 5 }),
      override({ active_count: 4 }),
    ]

    expect(suggestCapRaise({ entries, cap: 3, now: NOW, ...WINDOW })?.suggestedCap).toBe(6)
  })

  // A timestamp ahead of now is a hand edit rather than a raise, and reading it as one would let a
  // single bad line hold the suggestion open.
  it('drops a raise dated in the future', () => {
    const entries = [
      ...times({ count: 3 }),
      override({ timestamp: new Date(2026, 7, 21).toISOString() }),
    ]

    expect(suggestCapRaise({ entries, cap: 3, now: NOW, ...WINDOW })).toBeUndefined()
  })
})
