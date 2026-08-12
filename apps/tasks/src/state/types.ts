/**
 * The states a task can be stored in, written as a tag on the task line. `stalled` is deliberately
 * absent: it is computed from how long an `#active` task has gone untouched, never stored, so it
 * can't become a resting place. A task carrying no tag is a valid, permanent sixth condition that
 * every part of the system ignores.
 */
export const TASK_STATES = ['someday', 'active', 'done', 'abandoned'] as const

export type TaskState = (typeof TASK_STATES)[number]

/** The two states nothing moves out of. */
export const TERMINAL_STATES: readonly TaskState[] = ['done', 'abandoned']

/**
 * What a task's checkbox says, independent of any state tag. `other` covers checkbox characters
 * this app has no rule for, so an unrecognised status is ignored rather than guessed at.
 */
export const TASK_STATUSES = ['open', 'done', 'cancelled', 'other'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
