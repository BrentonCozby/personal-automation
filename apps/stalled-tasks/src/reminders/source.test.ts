import { AppError } from '@personal-automation/common/errors'
import { expect, it } from 'vitest'
import { parseBridgeOutput } from './source.js'

function successJson(reminders: Record<string, unknown>[]): string {
  return JSON.stringify({ reminders })
}

const sampleReminder = {
  id: 'r1',
  title: 'book india flights',
  notes: null,
  list: 'Family',
  created: '2025-05-20T20:49:47Z',
  lastModified: '2026-04-06T14:29:51Z',
  due: '2026-06-24T07:00:00Z',
}

it('parses reminders into tasks and converts ISO strings to Dates', () => {
  const tasks = parseBridgeOutput({ raw: successJson([sampleReminder]), lists: [] })

  expect(tasks).toHaveLength(1)
  const task = tasks[0]
  expect(task?.id).toBe('r1')
  expect(task?.title).toBe('book india flights')
  expect(task?.created).toBeInstanceOf(Date)
  expect(task?.created?.toISOString()).toBe('2025-05-20T20:49:47.000Z')
  expect(task?.lastModified?.toISOString()).toBe('2026-04-06T14:29:51.000Z')
  expect(task?.due?.toISOString()).toBe('2026-06-24T07:00:00.000Z')
})

it('converts null timestamps to null', () => {
  const tasks = parseBridgeOutput({
    raw: successJson([{ ...sampleReminder, created: null, lastModified: null, due: null }]),
    lists: [],
  })

  expect(tasks[0]?.created).toBeNull()
  expect(tasks[0]?.lastModified).toBeNull()
  expect(tasks[0]?.due).toBeNull()
})

it('returns all lists when the filter is empty', () => {
  const tasks = parseBridgeOutput({
    raw: successJson([
      { ...sampleReminder, id: 'a', list: 'Family' },
      { ...sampleReminder, id: 'b', list: 'Reminders' },
    ]),
    lists: [],
  })

  expect(tasks.map(t => t.id)).toEqual(['a', 'b'])
})

it('filters to the requested lists', () => {
  const tasks = parseBridgeOutput({
    raw: successJson([
      { ...sampleReminder, id: 'a', list: 'Family' },
      { ...sampleReminder, id: 'b', list: 'Reminders' },
      { ...sampleReminder, id: 'c', list: 'Groceries' },
    ]),
    lists: ['Family', 'Groceries'],
  })

  expect(tasks.map(t => t.id)).toEqual(['a', 'c'])
})

it('treats absent notes/due/timestamp keys as null (Swift omits nil optionals)', () => {
  // The real bridge emits no key at all for a nil optional, rather than an explicit null.
  const tasks = parseBridgeOutput({
    raw: successJson([{ id: 'r1', title: 'sharpen knives', list: 'Reminders' }]),
    lists: [],
  })

  expect(tasks[0]?.notes).toBeNull()
  expect(tasks[0]?.due).toBeNull()
  expect(tasks[0]?.created).toBeNull()
  expect(tasks[0]?.lastModified).toBeNull()
})

it('drops recurring reminders (their own alert is the channel for them)', () => {
  const tasks = parseBridgeOutput({
    raw: successJson([
      { ...sampleReminder, id: 'once', title: 'book india flights', recurring: false },
      { ...sampleReminder, id: 'repeat', title: 'water the plants', recurring: true },
    ]),
    lists: [],
  })

  expect(tasks.map(t => t.id)).toEqual(['once'])
})

it('returns an empty array when there are no open reminders', () => {
  expect(parseBridgeOutput({ raw: successJson([]), lists: [] })).toEqual([])
})

it('throws a clear AppError with grant instructions when access is not authorized', () => {
  const raw = JSON.stringify({ error: 'not_authorized', status: 2 })

  expect(() => parseBridgeOutput({ raw, lists: [] })).toThrow(AppError)
  expect(() => parseBridgeOutput({ raw, lists: [] })).toThrow(/access not granted/)
  expect(() => parseBridgeOutput({ raw, lists: [] })).toThrow(/Privacy & Security → Reminders/)
})

it('throws an AppError naming any other bridge error', () => {
  const raw = JSON.stringify({ error: 'fetch_failed' })

  expect(() => parseBridgeOutput({ raw, lists: [] })).toThrow(/fetch_failed/)
})

it('throws an AppError on unparseable bridge output', () => {
  expect(() => parseBridgeOutput({ raw: 'not json at all', lists: [] })).toThrow(AppError)
  expect(() => parseBridgeOutput({ raw: 'not json at all', lists: [] })).toThrow(/invalid JSON/)
})
