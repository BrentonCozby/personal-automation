// Gmail threads consecutive weeks by matching subject prefix, so the digest reads as one
// ongoing review rather than a new email each week.
export const SUBJECT_PREFIX = 'Task Review'

// Tuning records go here (NOT audit/) so notify's `apps/*/audit/*` glob never reads them —
// see the plan's notify-interaction note.
export const RUNS_DIR_NAME = 'runs'
