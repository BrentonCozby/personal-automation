// Gmail still threads consecutive emails by matching subject prefix.
export const SUBJECT_PREFIX = 'Personal Automation'

// Notify itself is not part of the apps it reports on. Audit-log discovery skips this
// name to defend against an accidental future change that gives notify its own audit log.
export const SELF_APP_NAME = 'notify'

// ynab-enrich-memos writes the Amazon memos that ynab-categorize then categorizes, so its
// per-transaction successes cover the same transactions already listed under ynab-categorize.
// For these apps the digest keeps the success *count* in the section header but drops the
// redundant per-transaction success rows. Errors are always shown in full.
export const SUMMARY_ONLY_SUCCESS_APPS = new Set(['ynab-enrich-memos'])
