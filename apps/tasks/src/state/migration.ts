import { AppError } from '@personal-automation/common/errors'
import type { TaskState, TaskStatus } from './types.js'

/** Why a task was left as it is. Carried so the dry run can report what it skipped and why. */
export const LEAVE_REASONS = [
  'already tagged',
  'already finished',
  'recurring',
  'unknown status',
  'more than one state tag',
] as const

export type LeaveReason = (typeof LEAVE_REASONS)[number]

export type MigrationTarget =
  | { kind: 'set'; state: TaskState }
  | { kind: 'leave'; reason: LeaveReason }

/**
 * The state a task should carry after the one-time migration, or a reason to leave it alone.
 *
 * The pass tags exactly one thing: an open, one-off, untagged task becomes `#someday`. Every other
 * line it meets already says what it is.
 *
 * Nothing here can produce `active`. Promoting is a decision the user makes three at a time, and
 * any signal used to guess at it (recency, priority, a nearby tag) would invent commitments that
 * were never made and fill the cap before they saw it.
 */
export function migrationTargetFor({
  status,
  isRecurring,
  states,
}: {
  status: TaskStatus
  isRecurring: boolean
  states: readonly TaskState[]
}): MigrationTarget {
  // A line carrying two states is left for a person to resolve. Rewriting it would clear both and
  // write one, which is a silent choice between two things the line says.
  if (states.length > 1) return { kind: 'leave', reason: 'more than one state tag' }
  // Leaving tagged lines alone is what makes a second run a no-op.
  if (states.length === 1) return { kind: 'leave', reason: 'already tagged' }

  switch (status) {
    case 'open':
      // Recurrence exempts a task only while it is live; see the `done` case.
      if (isRecurring) return { kind: 'leave', reason: 'recurring' }

      return { kind: 'set', state: 'someday' }
    // A finished task needs no tag: the checkbox already records it, the done list reads the ✅
    // date rather than a tag, and the cap only ever counts tasks whose box is still open. Writing
    // #done here would repeat the line and freeze a reusable checklist's ticks into its template.
    case 'done':
    case 'cancelled':
      return { kind: 'leave', reason: 'already finished' }
    case 'other':
      return { kind: 'leave', reason: 'unknown status' }
    default: {
      const _exhaustive: never = status
      throw new AppError({ message: `Unknown task status: ${String(_exhaustive)}` })
    }
  }
}
