import { calendarDaysBetween } from './days.js'
import type { TaskStatus } from './types.js'
import type { CapCandidate } from './wip.js'

/** What the done list needs to know about a task: what it was, and how its box was closed. */
export type ClosedTask = {
  title: string
  list: string
  status: TaskStatus
  closed: Date | null
}

/** One entry in the done list: a task, the last day it was closed, and how often. */
export type DoneEntry = {
  title: string
  list: string
  closed: Date
  /** More than one when a recurring chore was completed several times inside the window. */
  times: number
}

/**
 * What the last stretch of days actually produced: a record of what you did, which is the half of
 * the model that has to be readable without a task being wrong. Dropping is a win here rather than a
 * gap, because choosing what not to carry is the point.
 *
 * The counts are of closures rather than of entries, because a chore done three times was three
 * things done, even though it reads as one line.
 */
export type DoneList = {
  finished: DoneEntry[]
  dropped: DoneEntry[]
  finishedCount: number
  droppedCount: number
}

/**
 * The tasks closed inside the window, most recent first.
 *
 * Read straight from the `✅` and `❌` dates on the line, so a task ticked by hand in Obsidian counts
 * exactly like one closed by `abandon`. The window is `windowDays` calendar days counting today, so
 * with 7 it covers today and the six days before it. A closing date in the future is a typo or a hand
 * edit rather than a win, so it is left out.
 */
export function closedSince({
  tasks,
  windowDays,
  now,
}: {
  tasks: readonly ClosedTask[]
  windowDays: number
  now: Date
}): DoneList {
  // flatMap rather than filter, so the closing date is narrowed to a real one on the way through and
  // no entry can carry a null date.
  const inWindow = tasks
    .flatMap(task => {
      if (!task.closed) return []
      if (task.status !== 'done' && task.status !== 'cancelled') return []
      const days = calendarDaysBetween({ from: task.closed, to: now })
      if (days < 0 || days >= windowDays) return []

      return [{ status: task.status, title: task.title, list: task.list, closed: task.closed }]
    })
    .sort((left, right) => right.closed.getTime() - left.closed.getTime())
  const finished = inWindow.filter(task => task.status === 'done')
  const dropped = inWindow.filter(task => task.status === 'cancelled')

  return {
    finished: collapse(finished),
    dropped: collapse(dropped),
    finishedCount: finished.length,
    droppedCount: dropped.length,
  }
}

/**
 * One entry per task, carrying its most recent closing day and how many times it closed.
 *
 * A recurring chore leaves one closed line per completion, so a week of them repeats the same title
 * several times over. Three identical lines state the same fact three times, and a list padded that
 * way reads as one. Identity is list plus title, the same rule the touch clock uses.
 */
function collapse(tasks: readonly Omit<DoneEntry, 'times'>[]): DoneEntry[] {
  const byTask = new Map<string, DoneEntry>()
  for (const task of tasks) {
    const key = JSON.stringify([task.list, task.title])
    const seen = byTask.get(key)
    // The input is newest first, so the first sighting of a task already carries its latest day.
    if (seen) {
      seen.times += 1
      continue
    }
    byTask.set(key, { title: task.title, list: task.list, closed: task.closed, times: 1 })
  }

  return [...byTask.values()]
}

/**
 * How many of the tasks being carried were touched inside the same window.
 *
 * The counterpart to the stall count: it says the closed list moved, which is the only progress
 * signal the vault holds for a task nobody has finished yet.
 */
export function countMoved({
  active,
  windowDays,
  now,
}: {
  active: readonly CapCandidate[]
  windowDays: number
  now: Date
}): number {
  return active.filter(task => {
    if (!task.lastTouched) return false
    const days = calendarDaysBetween({ from: task.lastTouched, to: now })

    return days >= 0 && days < windowDays
  }).length
}
