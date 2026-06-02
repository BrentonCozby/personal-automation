import type { Task } from './reminders/types.js'

const MS_PER_DAY = 86_400_000

export type DueStatus = 'past' | 'future' | 'none'

// The task's age in days, from its creation date (falling back to lastModified if creation is
// missing). Creation rather than last-modified so editing a task — adding a note, tweaking the
// title — doesn't reset its staleness; to reset, delete and recreate. Null when neither
// timestamp exists, so the model and ranking treat staleness as unknown.
export function staleDays({ task, now }: { task: Task; now: Date }): number | null {
  const ref = task.created ?? task.lastModified
  if (!ref) return null

  return Math.max(0, Math.floor((now.getTime() - ref.getTime()) / MS_PER_DAY))
}

// A future due date means Reminders' own alert has the task handled (scheduled, not stalled).
// A past due date on a still-open task is a strong stalled signal — the alert fired and was
// dismissed. A due date at or before `now` counts as past so a due-today task isn't dropped.
export function dueStatus({ due, now }: { due: Date | null; now: Date }): DueStatus {
  if (!due) return 'none'

  return due.getTime() <= now.getTime() ? 'past' : 'future'
}
