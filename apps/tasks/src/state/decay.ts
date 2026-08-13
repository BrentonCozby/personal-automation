import { untouchedDays } from './stall.js'
import { type CapCandidate, countsTowardCap } from './wip.js'

/**
 * Whether a commitment has gone quiet for so long that the system stops treating it as one: an
 * `#active` task nothing has touched for `horizonDays`.
 *
 * The horizon is how far ahead a date can honestly be seen, and a task nobody has touched for that
 * long is past the point where calling it current means anything. Decay demotes rather than closing
 * the checkbox, so the machine never drops a commitment the user did not agree to drop, and
 * `tasks promote` puts it straight back.
 *
 * A task the clock has never seen does not decay. Unreachable once the clock is reconciled, but a
 * deleted clock must not demote everything at once.
 *
 * The due date is deliberately not read, unlike the stall rule. `schedule` routes any date past the
 * horizon to `#someday`, so a date set inside it has gone by before this many untouched days pass,
 * and editing a date by hand is itself a touch.
 */
export function hasDecayed({
  task,
  horizonDays,
  now,
}: {
  task: CapCandidate
  horizonDays: number
  now: Date
}): boolean {
  if (!countsTowardCap(task)) return false
  const quiet = untouchedDays({ task, now })

  return quiet !== undefined && quiet >= horizonDays
}

/** The tasks to demote, in the order they were given. */
export function decayed<T extends CapCandidate>({
  tasks,
  horizonDays,
  now,
}: {
  tasks: readonly T[]
  horizonDays: number
  now: Date
}): T[] {
  return tasks.filter(task => hasDecayed({ task, horizonDays, now }))
}
