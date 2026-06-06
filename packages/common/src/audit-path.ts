import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The audit-log layout shared by the writer (createLogger) and the reader (notify). Both sides
 * import these so the directory name and filename can't drift: an app writes its JSONL to
 * `apps/<app>/audit/<app>-<date>.jsonl`, and notify reads exactly that path.
 */
export const AUDIT_DIR_NAME = 'audit'

/** The audit JSONL filename for one app on one day, e.g. `ynab-categorize-2026-06-05.jsonl`. */
export function auditFileName({ app, date }: { app: string; date: string }): string {
  return `${app}-${date}.jsonl`
}

/**
 * The audit directory for the app whose module URL is passed in, resolved relative to the
 * module (CWD-independent) as `apps/<app>/audit`. An app's config.ts (at `apps/<app>/src/`)
 * calls `appAuditDir(import.meta.url)`; notify reads the same `apps/<app>/audit` location, so
 * the two can't disagree about where audit logs live.
 */
export function appAuditDir(callerUrl: string): string {
  const callerDir = path.dirname(fileURLToPath(callerUrl))

  return path.resolve(callerDir, '..', AUDIT_DIR_NAME)
}
