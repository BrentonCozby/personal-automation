import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  emptyTouchClock,
  fingerprintOf,
  lastTouchedOf,
  readTouchClock,
  reconcileTouchClock,
  recordTouch,
  type TouchClock,
  touchKey,
  writeTouchClock,
} from './touch-clock.js'

const MONDAY = new Date('2026-08-10T09:00:00.000Z')
const FRIDAY = new Date('2026-08-14T09:00:00.000Z')

function clockWith(tasks: TouchClock['tasks']): TouchClock {
  return { version: 1, tasks }
}

describe('touchKey', () => {
  it('is the same before and after a state change, because the title is already stripped', () => {
    expect(touchKey({ list: 'todos', title: 'fix the bike' })).toBe(
      touchKey({ list: 'todos', title: 'fix the bike' }),
    )
  })

  it('separates two tasks with the same title in different lists', () => {
    expect(touchKey({ list: 'todos', title: 'call mom' })).not.toBe(
      touchKey({ list: 'work', title: 'call mom' }),
    )
  })

  // A joined string would give these two the same key, so one task's clock would follow the other.
  it('does not collide when a title contains the separator characters', () => {
    expect(touchKey({ list: 'a', title: '","b' })).not.toBe(touchKey({ list: 'a","', title: 'b' }))
  })
})

describe('fingerprintOf', () => {
  it('is stable for the same text and different for changed text', () => {
    const before = fingerprintOf('- [ ] fix the bike 📅 2026-08-20')
    const after = fingerprintOf('- [ ] fix the bike 📅 2026-08-27')

    expect(fingerprintOf('- [ ] fix the bike 📅 2026-08-20')).toBe(before)
    expect(after).not.toBe(before)
  })
})

describe('reconcileTouchClock', () => {
  it('stamps every task as touched now on a cold start', () => {
    const clock = reconcileTouchClock({
      stored: emptyTouchClock(),
      tasks: [
        { key: 'a', fingerprint: 'sha256:1' },
        { key: 'b', fingerprint: 'sha256:2' },
      ],
      now: MONDAY,
    })

    expect(lastTouchedOf({ clock, key: 'a' })).toEqual(MONDAY)
    expect(lastTouchedOf({ clock, key: 'b' })).toEqual(MONDAY)
  })

  it('carries the stored timestamp forward when the fingerprint has not changed', () => {
    const clock = reconcileTouchClock({
      stored: clockWith({ a: { fingerprint: 'sha256:1', lastTouched: MONDAY.toISOString() } }),
      tasks: [{ key: 'a', fingerprint: 'sha256:1' }],
      now: FRIDAY,
    })

    expect(lastTouchedOf({ clock, key: 'a' })).toEqual(MONDAY)
  })

  it('stamps a changed fingerprint as touched now', () => {
    const clock = reconcileTouchClock({
      stored: clockWith({ a: { fingerprint: 'sha256:1', lastTouched: MONDAY.toISOString() } }),
      tasks: [{ key: 'a', fingerprint: 'sha256:changed' }],
      now: FRIDAY,
    })

    expect(lastTouchedOf({ clock, key: 'a' })).toEqual(FRIDAY)
    expect(clock.tasks['a']?.fingerprint).toBe('sha256:changed')
  })

  // The clock only tracks tasks that still exist. A completed or deleted task's entry would
  // otherwise sit there forever, and the file would only ever grow.
  it('drops entries for tasks that are no longer there', () => {
    const clock = reconcileTouchClock({
      stored: clockWith({
        gone: { fingerprint: 'sha256:1', lastTouched: MONDAY.toISOString() },
        here: { fingerprint: 'sha256:2', lastTouched: MONDAY.toISOString() },
      }),
      tasks: [{ key: 'here', fingerprint: 'sha256:2' }],
      now: FRIDAY,
    })

    expect(Object.keys(clock.tasks)).toEqual(['here'])
  })

  it('keeps the first of two tasks sharing a key, so the entry cannot flip every run', () => {
    const clock = reconcileTouchClock({
      stored: clockWith({ a: { fingerprint: 'sha256:first', lastTouched: MONDAY.toISOString() } }),
      tasks: [
        { key: 'a', fingerprint: 'sha256:first' },
        { key: 'a', fingerprint: 'sha256:second' },
      ],
      now: FRIDAY,
    })

    expect(lastTouchedOf({ clock, key: 'a' })).toEqual(MONDAY)
  })
})

describe('recordTouch', () => {
  it('stamps one task without disturbing the others', () => {
    const clock = recordTouch({
      clock: clockWith({
        a: { fingerprint: 'sha256:1', lastTouched: MONDAY.toISOString() },
        b: { fingerprint: 'sha256:2', lastTouched: MONDAY.toISOString() },
      }),
      key: 'a',
      fingerprint: 'sha256:promoted',
      now: FRIDAY,
    })

    expect(lastTouchedOf({ clock, key: 'a' })).toEqual(FRIDAY)
    expect(lastTouchedOf({ clock, key: 'b' })).toEqual(MONDAY)
  })
})

describe('lastTouchedOf', () => {
  it('is undefined for a task the clock has never seen', () => {
    expect(lastTouchedOf({ clock: emptyTouchClock(), key: 'missing' })).toBeUndefined()
  })
})

describe('reading and writing', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'touch-clock-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads back what it wrote', async () => {
    const path = join(dir, 'touch-clock.json')
    const clock = clockWith({ a: { fingerprint: 'sha256:1', lastTouched: MONDAY.toISOString() } })
    await writeTouchClock({ path, clock })

    expect(await readTouchClock(path)).toEqual(clock)
  })

  it('creates the runs directory when it is not there yet', async () => {
    const path = join(dir, 'runs', 'touch-clock.json')
    await writeTouchClock({ path, clock: emptyTouchClock() })

    expect(await readTouchClock(path)).toEqual(emptyTouchClock())
  })

  it('leaves no temporary file behind', async () => {
    const path = join(dir, 'touch-clock.json')
    await writeTouchClock({ path, clock: emptyTouchClock() })

    expect(await readdir(dir)).toEqual(['touch-clock.json'])
  })

  // The cold start. A missing clock is the normal first run, not a failure.
  it('reads a missing file as an empty clock', async () => {
    expect(await readTouchClock(join(dir, 'not-there.json'))).toEqual(emptyTouchClock())
  })

  it('refuses a file that is not JSON, and says it can be deleted', async () => {
    const path = join(dir, 'touch-clock.json')
    await writeFile(path, 'not json at all')

    await expect(readTouchClock(path)).rejects.toThrow(AppError)
    await expect(readTouchClock(path)).rejects.toThrow(/Delete it and it rebuilds/)
  })

  it('refuses a file whose shape is wrong', async () => {
    const path = join(dir, 'touch-clock.json')
    await writeFile(path, JSON.stringify({ version: 1, tasks: { a: { fingerprint: 'sha256:1' } } }))

    await expect(readTouchClock(path)).rejects.toThrow(/not readable as one/)
  })

  it('refuses a version it does not know', async () => {
    const path = join(dir, 'touch-clock.json')
    await writeFile(path, JSON.stringify({ version: 2, tasks: {} }))

    await expect(readTouchClock(path)).rejects.toThrow(/not readable as one/)
  })
})
