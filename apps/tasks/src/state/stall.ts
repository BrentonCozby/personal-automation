import { calendarDaysBetween, dueStatus } from './days.js'
import { type CapCandidate, countsTowardCap } from './wip.js'

/**
 * Calendar days since the task was last touched, or undefined when the touch clock has never seen
 * it. Any edit to the task's line or its notes counts as a touch, as does promoting or scheduling it.
 */
export function untouchedDays({
  task,
  now,
}: {
  task: CapCandidate
  now: Date
}): number | undefined {
  if (!task.lastTouched) return undefined

  return calendarDaysBetween({ from: task.lastTouched, to: now })
}

/**
 * Whether the task has gone quiet: something you committed to, with no touch inside the stall
 * window and no date still ahead of it.
 *
 * A date in the future means the task is scheduled, not stuck, so it waits for its day. The two
 * rules can't fight each other, because scheduling a task is itself a touch: naming a date both
 * resets the window and puts the date ahead of now.
 *
 * A task the clock has never seen does not stall. Every open task is in the clock by the time this
 * runs, so this only covers a clock that was deleted, where an unknown age is not evidence of
 * anything and reading it as a stall would nag about every task at once.
 */
export function isStalled({
  task,
  stallDays,
  now,
}: {
  task: CapCandidate
  stallDays: number
  now: Date
}): boolean {
  if (!countsTowardCap(task)) return false
  if (dueStatus({ due: task.due, now }) === 'future') return false
  const quiet = untouchedDays({ task, now })

  return quiet !== undefined && quiet >= stallDays
}

/**
 * Stalled tasks ordered longest untouched first, with the soonest due date breaking ties and an
 * undated task last.
 *
 * The tie is the ordinary case rather than an edge one: a rebuilt clock stamps every task with the
 * same timestamp, so a whole week's digest can share one day count.
 */
export function orderByLongestUntouched<T extends CapCandidate>(tasks: readonly T[]): T[] {
  return [...tasks].sort((left, right) => {
    const touched = touchTime(left.lastTouched) - touchTime(right.lastTouched)
    if (touched !== 0) return touched

    return dueTime(left.due) - dueTime(right.due)
  })
}

// A task the clock has never seen sorts last, the same way it does in the cap's ordering.
function touchTime(value: Date | undefined): number {
  return value ? value.getTime() : Number.POSITIVE_INFINITY
}

// No due date is not the same as due today, so an undated task sorts after every dated one.
function dueTime(value: Date | null): number {
  return value ? value.getTime() : Number.POSITIVE_INFINITY
}
