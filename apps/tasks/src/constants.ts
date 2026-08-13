/**
 * Gmail threads consecutive digests by matching subject prefix, so they read as one ongoing
 * review rather than a fresh thread each run.
 */
export const SUBJECT_PREFIX = 'Task Review'

/**
 * Tuning records go here (NOT audit/) so notify's `apps/<app>/audit/` glob never reads them.
 */
export const RUNS_DIR_NAME = 'runs'

/**
 * How the CLI is invoked from the repo root. The digest prints commands to paste, so this has to
 * match the `tasks` script in this app's package.json.
 */
export const CLI_INVOCATION = 'pnpm --filter @personal-automation/tasks tasks'

/** Where this app's own settings live, relative to the repo root. The digest names it to edit. */
export const ENV_FILE = 'apps/tasks/.env'

/** The label under the push's tap target. Pushover shows it beside the link. */
export const ALERT_URL_TITLE = 'Open the dashboard'
