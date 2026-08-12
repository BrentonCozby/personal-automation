import { describe, expect, it } from 'vitest'
import { dueStatus, staleDays } from './staleness.js'
import type { Task } from './tasks/types.js'

const NOW = new Date('2026-06-02T12:00:00Z')

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'r1',
    title: 'a task',
    notes: null,
    created: null,
    lastModified: null,
    due: null,
    list: 'todos',
    ...overrides,
  }
}

describe('staleDays', () => {
  // Dividing raw milliseconds loses the hour a spring-forward takes, so a span of exactly the
  // threshold reports one day short and every check fires a day late.
  it('counts a span containing a daylight-saving change in calendar days', () => {
    const originalTz = process.env['TZ']
    process.env['TZ'] = 'America/Los_Angeles'
    try {
      const result = staleDays({
        task: task({ created: new Date(2026, 1, 20) }),
        now: new Date(2026, 2, 22),
      })

      expect(result).toBe(30)
    } finally {
      process.env['TZ'] = originalTz
    }
  })

  it('counts days since creation, ignoring last-modified', () => {
    const result = staleDays({
      task: task({
        created: new Date('2026-05-03T12:00:00Z'),
        lastModified: new Date('2026-06-02T00:00:00Z'),
      }),
      now: NOW,
    })

    expect(result).toBe(30)
  })

  it('falls back to lastModified when creation is missing', () => {
    const result = staleDays({
      task: task({ lastModified: new Date('2026-05-23T12:00:00Z') }),
      now: NOW,
    })

    expect(result).toBe(10)
  })

  it('returns null when neither timestamp exists', () => {
    expect(staleDays({ task: task(), now: NOW })).toBeNull()
  })

  it('clamps to 0 when the timestamp is in the future', () => {
    const result = staleDays({
      task: task({ created: new Date('2026-06-10T00:00:00Z') }),
      now: NOW,
    })

    expect(result).toBe(0)
  })

  it('floors partial days', () => {
    const result = staleDays({
      task: task({ created: new Date('2026-06-01T00:00:00Z') }),
      now: NOW,
    })

    expect(result).toBe(1)
  })
})

describe('dueStatus', () => {
  it('is none when there is no due date', () => {
    expect(dueStatus({ due: null, now: NOW })).toBe('none')
  })

  it('is future when the due date is ahead of now', () => {
    expect(dueStatus({ due: new Date('2026-06-24T07:00:00Z'), now: NOW })).toBe('future')
  })

  it('is past when the due date has passed', () => {
    expect(dueStatus({ due: new Date('2025-06-07T07:00:00Z'), now: NOW })).toBe('past')
  })

  it('treats a due date exactly at now as past', () => {
    expect(dueStatus({ due: new Date('2026-06-02T12:00:00Z'), now: NOW })).toBe('past')
  })
})
