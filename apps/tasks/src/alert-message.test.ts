import { afterEach, beforeEach, expect, it } from 'vitest'
import { buildAlertMessage } from './alert-message.js'

// The title compares due dates against today, which is a local calendar date.
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

const NOW = new Date(2026, 7, 20, 8, 0)
const TODAY = new Date(2026, 7, 20)

it('lists what is due, one bulleted item per line', () => {
  const result = buildAlertMessage({
    due: [
      { title: 'give Dolly her meds', due: TODAY },
      { title: 'water the schefflera', due: TODAY },
    ],
    demoted: [],
    now: NOW,
  })

  expect(result.title).toBe('Due today (2)')
  expect(result.message).toBe('• give Dolly her meds\n• water the schefflera')
})

// "Due today" would be a lie about a task dated last week, and the banner is the only place this
// text is read.
it('says overdue when something on the list is older than today', () => {
  const result = buildAlertMessage({
    due: [
      { title: 'give Dolly her meds', due: new Date(2026, 7, 18) },
      { title: 'water the schefflera', due: TODAY },
    ],
    demoted: [],
    now: NOW,
  })

  expect(result.title).toBe('Due or overdue (2)')
})

// The machine is dropping a commitment the user did not drop, so they learn it when it happens.
it('announces a demotion on its own', () => {
  const result = buildAlertMessage({
    due: [],
    demoted: [{ title: 'book india flights', untouchedDays: 31 }],
    now: NOW,
  })

  expect(result.title).toBe('Moved to someday (1)')
  expect(result.message).toBe('Moved to someday:\n• book india flights, untouched 31 days')
})

it('puts the demotion under what is due when both have something', () => {
  const result = buildAlertMessage({
    due: [{ title: 'give Dolly her meds', due: TODAY }],
    demoted: [{ title: 'book india flights', untouchedDays: 31 }],
    now: NOW,
  })

  expect(result.title).toBe('Due today (1)')
  expect(result.message).toBe(
    '• give Dolly her meds\n\nMoved to someday:\n• book india flights, untouched 31 days',
  )
})

it('renders an empty pair as an empty message', () => {
  expect(buildAlertMessage({ due: [], demoted: [], now: NOW })).toEqual({
    title: 'Moved to someday (0)',
    message: '',
  })
})

// Pushover truncates at 1024 bytes itself, which would cut a title in half. The count of what was
// left out is more useful than half a task name.
it('drops whole items and names how many, rather than being cut mid-title', () => {
  const due = Array.from({ length: 60 }, (_, index) => ({
    title: `a task with a fairly long name, number ${index}`,
    due: TODAY,
  }))

  const result = buildAlertMessage({ due, demoted: [], now: NOW })

  expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(1024)
  expect(result.message).toMatch(/\n• and \d+ more$/)
  expect(result.title).toBe('Due today (60)')
})

// A demotion is news that arrives nowhere else, so it survives the truncation that trims the list.
it('keeps the demotion when the due list is truncated', () => {
  const due = Array.from({ length: 60 }, (_, index) => ({
    title: `a task with a fairly long name, number ${index}`,
    due: TODAY,
  }))

  const result = buildAlertMessage({
    due,
    demoted: [{ title: 'book india flights', untouchedDays: 31 }],
    now: NOW,
  })

  expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(1024)
  expect(result.message).toContain('book india flights, untouched 31 days')
})
