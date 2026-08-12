import { afterEach, beforeEach, expect, test } from 'vitest'
import { calendarDaysBetween } from './days.js'

// Every threshold in this app is a count of local calendar days, so the tests have to pin a zone
// rather than inherit the machine's. Los_Angeles is the current zone; the DST dates below are its
// 2026 transitions (spring forward 2026-03-08, fall back 2026-11-01).
const originalTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'America/Los_Angeles'
})

afterEach(() => {
  process.env['TZ'] = originalTz
})

test('two times on the same calendar day are zero days apart', () => {
  const from = new Date(2026, 4, 12, 0, 1)
  const to = new Date(2026, 4, 12, 23, 59)

  expect(calendarDaysBetween({ from, to })).toBe(0)
})

test('counts the calendar rollover, not a 24-hour span', () => {
  const from = new Date(2026, 4, 12, 23, 59)
  const to = new Date(2026, 4, 13, 0, 1)

  expect(calendarDaysBetween({ from, to })).toBe(1)
})

test('counts a spring-forward day as one day despite it being 23 hours', () => {
  const from = new Date(2026, 2, 7)
  const to = new Date(2026, 2, 9)

  expect(calendarDaysBetween({ from, to })).toBe(2)
})

test('counts a fall-back day as one day despite it being 25 hours', () => {
  const from = new Date(2026, 10, 1)
  const to = new Date(2026, 10, 2)

  expect(calendarDaysBetween({ from, to })).toBe(1)
})

// The failure this app actually cares about: a 30-day span containing a spring-forward loses an
// hour, so dividing raw milliseconds and flooring reports 29 and a threshold check fires a day late.
test('reports a 30-day span containing a spring-forward as 30 days', () => {
  const from = new Date(2026, 1, 20)
  const to = new Date(2026, 2, 22)

  expect(calendarDaysBetween({ from, to })).toBe(30)
})

test('returns a negative count when the range runs backwards', () => {
  const from = new Date(2026, 4, 13)
  const to = new Date(2026, 4, 12)

  expect(calendarDaysBetween({ from, to })).toBe(-1)
})
