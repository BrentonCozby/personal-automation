import { calendarDaysBetween } from './state/days.js'
import type { Task } from './tasks/types.js'

export type DueStatus = 'past' | 'future' | 'none'

/**
 * The task's age in days, from its creation date (falling back to lastModified if creation is
 * missing). Creation rather than last-modified so editing a task — adding a note, tweaking the
 * title — doesn't reset its staleness; to reset, delete and recreate. Null when neither
 * timestamp exists, so the model and ranking treat staleness as unknown.
 */
export function staleDays({ task, now }: { task: Task; now: Date }): number | null {
  const ref = task.created ?? task.lastModified
  if (!ref) return null

  return Math.max(0, calendarDaysBetween({ from: ref, to: now }))
}

/**
 * A future due date means the task is scheduled, not stalled — leave it until it comes due. A
 * past due date on a still-open task is a strong stalled signal. A due date at or before `now`
 * counts as past so a due-today task isn't dropped.
 */
export function dueStatus({ due, now }: { due: Date | null; now: Date }): DueStatus {
  if (!due) return 'none'

  return due.getTime() <= now.getTime() ? 'past' : 'future'
}
