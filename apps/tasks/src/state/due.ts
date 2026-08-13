import { calendarDaysBetween, dueStatus } from './days.js'
import type { TaskStatus } from './types.js'

/**
 * What the alert rule reads. A structural subset of `ScannedTask`, so a scan result goes straight
 * in.
 *
 * No state tag is read. Putting a date on something is the reason to want reminding of it, so a
 * dated `#someday` task alerts exactly like a dated `#active` one.
 */
export type DueCandidate = {
  title: string
  status: TaskStatus
  isRecurring: boolean
  due: Date | null
}

/**
 * Whether the task belongs on today's push: open, dated, and the date has arrived or gone by.
 *
 * How long it keeps being asked about differs by kind. A recurring chore is asked about every day
 * until it is ticked, with no limit, because the Tasks plugin only rolls its date forward on the
 * tick, so the date staying past is exactly the signal that the chore was missed. Everything else
 * stops after `dueAlertDays` and is left to the twice-weekly review, which is what keeps a task
 * dated months ago from pushing daily forever.
 */
export function isDueForAlert({
  task,
  dueAlertDays,
  now,
}: {
  task: DueCandidate
  dueAlertDays: number
  now: Date
}): boolean {
  const due = task.due
  if (task.status !== 'open' || !due) return false
  if (dueStatus({ due, now }) !== 'past') return false
  if (task.isRecurring) return true

  return calendarDaysBetween({ from: due, to: now }) < dueAlertDays
}

/**
 * The tasks to push, most overdue first, ties in alphabetical order.
 *
 * The banner is read in one glance, so the oldest debt leads and the order is stable between the
 * morning pass and the evening one.
 */
export function dueForAlert<T extends DueCandidate>({
  tasks,
  dueAlertDays,
  now,
}: {
  tasks: readonly T[]
  dueAlertDays: number
  now: Date
}): T[] {
  return tasks
    .filter(task => isDueForAlert({ task, dueAlertDays, now }))
    .sort((left, right) => dueTime(left) - dueTime(right) || left.title.localeCompare(right.title))
}

function dueTime(task: DueCandidate): number {
  return task.due?.getTime() ?? 0
}
