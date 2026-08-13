import { describe, expect, it } from 'vitest'
import { type CapCandidate, countsTowardCap, orderByClosestToDone } from './wip.js'

function candidate(overrides: Partial<CapCandidate> = {}): CapCandidate {
  return {
    title: 'a task',
    list: 'todos',
    status: 'open',
    isRecurring: false,
    state: 'active',
    due: null,
    lastTouched: undefined,
    ...overrides,
  }
}

describe('countsTowardCap', () => {
  it('counts an open #active task', () => {
    expect(countsTowardCap(candidate())).toBe(true)
  })

  it('does not count a task in another state, or none', () => {
    expect(countsTowardCap(candidate({ state: 'someday' }))).toBe(false)
    expect(countsTowardCap(candidate({ state: undefined }))).toBe(false)
  })

  it('does not count a finished task, whatever tag it carries', () => {
    expect(countsTowardCap(candidate({ status: 'done' }))).toBe(false)
    expect(countsTowardCap(candidate({ status: 'cancelled' }))).toBe(false)
  })

  // A recurring chore is managed by its recurrence rule, so it was never one of the three things
  // you chose to carry.
  it('does not count a recurring task', () => {
    expect(countsTowardCap(candidate({ isRecurring: true }))).toBe(false)
  })
})

describe('orderByClosestToDone', () => {
  it('puts the most recently touched first', () => {
    const ordered = orderByClosestToDone([
      candidate({ title: 'old', lastTouched: new Date('2026-08-01T00:00:00Z') }),
      candidate({ title: 'recent', lastTouched: new Date('2026-08-10T00:00:00Z') }),
    ])

    expect(ordered.map(task => task.title)).toEqual(['recent', 'old'])
  })

  it('breaks a tie on the soonest due date', () => {
    const touched = new Date('2026-08-10T00:00:00Z')
    const ordered = orderByClosestToDone([
      candidate({ title: 'later', due: new Date('2026-09-01T00:00:00Z'), lastTouched: touched }),
      candidate({ title: 'sooner', due: new Date('2026-08-15T00:00:00Z'), lastTouched: touched }),
    ])

    expect(ordered.map(task => task.title)).toEqual(['sooner', 'later'])
  })

  it('sorts an undated task after a dated one on a tie', () => {
    const touched = new Date('2026-08-10T00:00:00Z')
    const ordered = orderByClosestToDone([
      candidate({ title: 'undated', due: null, lastTouched: touched }),
      candidate({ title: 'dated', due: new Date('2026-09-01T00:00:00Z'), lastTouched: touched }),
    ])

    expect(ordered.map(task => task.title)).toEqual(['dated', 'undated'])
  })

  it('sorts a task the clock has never seen last', () => {
    const ordered = orderByClosestToDone([
      candidate({ title: 'unseen', lastTouched: undefined }),
      candidate({ title: 'seen', lastTouched: new Date('2026-08-01T00:00:00Z') }),
    ])

    expect(ordered.map(task => task.title)).toEqual(['seen', 'unseen'])
  })

  it('leaves the input array alone', () => {
    const tasks = [
      candidate({ title: 'old', lastTouched: new Date('2026-08-01T00:00:00Z') }),
      candidate({ title: 'recent', lastTouched: new Date('2026-08-10T00:00:00Z') }),
    ]
    orderByClosestToDone(tasks)

    expect(tasks.map(task => task.title)).toEqual(['old', 'recent'])
  })
})
