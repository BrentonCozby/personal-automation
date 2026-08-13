import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNS_DIR_NAME } from './constants.js'

// Resolved relative to this module (app dir), not CWD, so the records always land in
// apps/tasks/runs/ — outside notify's apps/*/audit/* glob, which would mail them to you as
// failures. Raising the cap for one promotion is a legitimate use of the system, not an error.
const DEFAULT_RUNS_DIR = fileURLToPath(new URL(`../${RUNS_DIR_NAME}/`, import.meta.url))

const FILE_NAME = 'overrides.jsonl'

export type OverrideEntry = {
  timestamp: string
  title: string
  list: string
  /** The cap that was in force, and how many tasks were already active when it was raised. */
  cap: number
  active_count: number
}

/**
 * Records one raised cap, appended to runs/overrides.jsonl.
 *
 * No reason is asked for and no warning is printed. The record exists so the digest can notice
 * that a rule routed around often enough is a rule that doesn't fit, and suggest raising the
 * default cap — never that you try harder.
 */
export function appendOverride({
  entry,
  dir = DEFAULT_RUNS_DIR,
}: {
  entry: OverrideEntry
  dir?: string
}): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, FILE_NAME), `${JSON.stringify(entry)}\n`)
}
