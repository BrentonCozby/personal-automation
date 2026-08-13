import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  calendarDaysBetween,
  dueStatus,
  isTaskDateShape,
  localIsoDate,
  parseTaskDate,
} from './days.js'

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

// An evening in a negative-offset zone is already tomorrow in UTC, so toISOString would write the
// wrong day into the vault.
test('writes the local calendar date, not the UTC one', () => {
  expect(localIsoDate(new Date(2026, 7, 20, 23, 30))).toBe('2026-08-20')
})

test('pads single-digit months and days', () => {
  expect(localIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
})

test('reads a full date as local midnight', () => {
  const parsed = parseTaskDate({ input: '2026-08-20', now: new Date(2026, 7, 12) })

  expect(parsed).toEqual(new Date(2026, 7, 20))
})

test('reads +Nd as that many days from today', () => {
  const parsed = parseTaskDate({ input: '+7d', now: new Date(2026, 7, 12, 14, 30) })

  expect(parsed).toEqual(new Date(2026, 7, 19))
})

test('counts +Nd across a month boundary', () => {
  const parsed = parseTaskDate({ input: '+20d', now: new Date(2026, 7, 20) })

  expect(parsed).toEqual(new Date(2026, 8, 9))
})

// The Date constructor rolls this forward into March rather than rejecting it, so a day that does
// not exist has to be caught by round-tripping the parts.
test('refuses a day that does not exist', () => {
  expect(parseTaskDate({ input: '2026-02-30', now: new Date(2026, 7, 12) })).toBeUndefined()
})

test('refuses text that is not a date', () => {
  expect(parseTaskDate({ input: 'next tuesday', now: new Date(2026, 7, 12) })).toBeUndefined()
})

test('recognises the two date shapes without needing a clock', () => {
  expect(isTaskDateShape('2026-08-20')).toBe(true)
  expect(isTaskDateShape('+7d')).toBe(true)
  expect(isTaskDateShape('bike')).toBe(false)
  expect(isTaskDateShape('7d')).toBe(false)
})

test('reports an undated task as none', () => {
  expect(dueStatus({ due: null, now: new Date(2026, 7, 20) })).toBe('none')
})

test('reports a date still ahead as future', () => {
  expect(dueStatus({ due: new Date(2026, 7, 25), now: new Date(2026, 7, 20) })).toBe('future')
})

test('reports a date gone by as past', () => {
  expect(dueStatus({ due: new Date(2026, 7, 10), now: new Date(2026, 7, 20) })).toBe('past')
})

// Due dates are local midnight, so a task due today is already behind `now` by the time anything
// reads it. Counting it as past is what keeps it in the day's list rather than dropping it.
test('reports a task due today as past', () => {
  expect(dueStatus({ due: new Date(2026, 7, 20), now: new Date(2026, 7, 20, 9, 0) })).toBe('past')
})
