// Gmail still threads consecutive emails by matching subject prefix.
export const SUBJECT_PREFIX = 'Personal Automation'

// Notify itself is not part of the apps it reports on, so its name appears in the
// glob skip list to defend against an accidental future change that gives it an
// audit log.
export const SELF_APP_NAME = 'notify'
