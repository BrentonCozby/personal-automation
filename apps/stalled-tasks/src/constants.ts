/**
 * Gmail threads consecutive digests by matching subject prefix, so they read as one ongoing
 * review rather than a fresh thread each run.
 */
export const SUBJECT_PREFIX = 'Task Review'

/**
 * Tuning records go here (NOT audit/) so notify's `apps/<app>/audit/` glob never reads them —
 * see the plan's notify-interaction note.
 */
export const RUNS_DIR_NAME = 'runs'
