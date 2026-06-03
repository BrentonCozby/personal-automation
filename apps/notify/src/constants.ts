// Gmail still threads consecutive emails by matching subject prefix.
export const SUBJECT_PREFIX = 'Personal Automation'

// Notify itself is not part of the apps it reports on. Audit-log discovery skips this
// name to defend against an accidental future change that gives notify its own audit log.
export const SELF_APP_NAME = 'notify'
