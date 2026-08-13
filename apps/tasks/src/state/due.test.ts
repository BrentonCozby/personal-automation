import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DueCandidate, dueForAlert, isDueForAlert } from './due.js'

// Alerting counts local calendar days, so the zone has to be pinned rather than inherited.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 9, 0)
const DUE_ALERT_DAYS = 7

function candidate(overrides: Partial<DueCandidate> = {}): DueCandidate {
  return {
    title: 'water the schefflera',
    status: 'open',
    isRecurring: false,
    due: new Date(2026, 7, 20),
    ...overrides,
  }
}

describe('isDueForAlert', () => {
  it('alerts a task due today', () => {
    expect(isDueForAlert({ task: candidate(), dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(true)
  })

  it('leaves a task due tomorrow alone', () => {
    const task = candidate({ due: new Date(2026, 7, 21) })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  it('leaves an undated task alone', () => {
    const task = candidate({ due: null })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  it('leaves a ticked task alone', () => {
    const task = candidate({ status: 'done' })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  // The taper: the due day plus the six after it, then the twice-weekly review takes over.
  it('alerts on the sixth day after the due date and stops on the seventh', () => {
    const sixth = candidate({ due: new Date(2026, 7, 14) })
    const seventh = candidate({ due: new Date(2026, 7, 13) })

    expect(isDueForAlert({ task: sixth, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(true)
    expect(isDueForAlert({ task: seventh, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(false)
  })

  // The meds case. An unticked recurring task keeps its past date, so it keeps being asked about.
  it('keeps alerting a recurring task long past its date', () => {
    const task = candidate({ isRecurring: true, due: new Date(2026, 6, 18) })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now: NOW })).toBe(true)
  })

  // Spring forward is 2026-03-08 in America/Los_Angeles. Subtracting timestamps would lose an hour
  // and floor the span to 6, keeping the task on the list a day too long.
  it('counts calendar days across a daylight saving change', () => {
    const now = new Date(2026, 2, 12, 9, 0)
    const task = candidate({ due: new Date(2026, 2, 5) })

    expect(isDueForAlert({ task, dueAlertDays: DUE_ALERT_DAYS, now })).toBe(false)
  })
})

describe('dueForAlert', () => {
  it('lists the most overdue first, then alphabetically', () => {
    const tasks = [
      candidate({ title: 'water the schefflera' }),
      candidate({ title: 'give Dolly her meds', due: new Date(2026, 7, 18) }),
      candidate({ title: 'a task due today' }),
      candidate({ title: 'call the vet', due: new Date(2026, 7, 25) }),
    ]

    expect(
      dueForAlert({ tasks, dueAlertDays: DUE_ALERT_DAYS, now: NOW }).map(task => task.title),
    ).toEqual(['give Dolly her meds', 'a task due today', 'water the schefflera'])
  })
})
