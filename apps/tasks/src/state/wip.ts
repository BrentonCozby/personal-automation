import type { TaskState, TaskStatus } from './types.js'

/** What the cap needs to know about a task: whether it counts, and where it sits in the order. */
export type CapCandidate = {
  title: string
  list: string
  status: TaskStatus
  isRecurring: boolean
  state: TaskState | undefined
  due: Date | null
  /** From the touch clock; undefined when the clock has never seen this task. */
  lastTouched: Date | undefined
}

/**
 * Whether a task counts against the work-in-progress cap: an open task tagged `#active`.
 *
 * Recurring tasks never count, even if one somehow carries the tag. A recurring chore is a live
 * commitment the Tasks plugin already manages through its recurrence rule, so counting it would
 * spend the cap on work that was never a choice.
 */
export function countsTowardCap(task: CapCandidate): boolean {
  return task.status === 'open' && task.state === 'active' && !task.isRecurring
}

/**
 * Active tasks ordered closest to done first: most recently touched, with the soonest due date
 * breaking ties. A task the clock has never seen sorts last.
 *
 * Momentum is the only signal the vault actually holds. There are no subtasks to compute a
 * completion fraction from and no effort estimates, so the task you touched yesterday is the best
 * available guess at the one you are part way through. Anything shown from this order has to name
 * the proxy, so a surprising order is never mysterious.
 */
export function orderByClosestToDone<T extends CapCandidate>(tasks: readonly T[]): T[] {
  return [...tasks].sort((left, right) => {
    const touched = time(right.lastTouched) - time(left.lastTouched)
    if (touched !== 0) return touched

    return dueTime(left.due) - dueTime(right.due)
  })
}

function time(value: Date | undefined): number {
  return value ? value.getTime() : Number.NEGATIVE_INFINITY
}

// Undated tasks sort after dated ones: no due date is not the same as due today.
function dueTime(value: Date | null): number {
  return value ? value.getTime() : Number.POSITIVE_INFINITY
}
