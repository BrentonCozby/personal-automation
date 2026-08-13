import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '@personal-automation/common/errors'
import { z } from 'zod'
import { RUNS_DIR_NAME } from './constants.js'

// Resolved relative to this module (app dir), not CWD, so the records always land in
// apps/tasks/runs/, outside notify's apps/*/audit/* glob, which would mail them to you as
// failures. Raising the cap for one promotion is a legitimate use of the system, not an error.
const DEFAULT_RUNS_DIR = fileURLToPath(new URL(`../${RUNS_DIR_NAME}/`, import.meta.url))

const FILE_NAME = 'overrides.jsonl'

const entrySchema = z.object({
  timestamp: z.iso.datetime(),
  title: z.string(),
  list: z.string(),
  // The cap that was in force, and how many tasks were already active when it was raised. Both are
  // read back: the cap decides which raises still count, the count decides what to suggest instead.
  cap: z.int().positive(),
  active_count: z.int().nonnegative(),
})

/** One raised cap, as `runs/overrides.jsonl` stores it. */
export type OverrideEntry = z.infer<typeof entrySchema>

/**
 * Records one raised cap, appended to runs/overrides.jsonl.
 *
 * No reason is asked for and no warning is printed. The record exists so the digest can notice
 * that a rule routed around often enough is a rule that doesn't fit, and suggest raising the
 * default cap, never that you try harder.
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

/**
 * Every raised cap on record, oldest first. Empty when the file doesn't exist, which is the state
 * it stays in until the first `--over-cap`.
 *
 * A line that doesn't parse stops the run rather than being skipped. Skipping would make the count
 * quietly low, and the only symptom would be a suggestion that never arrives, which is not something
 * anyone would notice was missing.
 */
export function readOverrides({ dir = DEFAULT_RUNS_DIR }: { dir?: string } = {}): OverrideEntry[] {
  const path = join(dir, FILE_NAME)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }

  return content
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => parseLine({ line, path }))
}

function parseLine({ line, path }: { line: string; path: string }): OverrideEntry {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    throw new AppError({ message: unreadableMessage(path), cause: err })
  }

  const parsed = entrySchema.safeParse(json)
  if (!parsed.success) throw new AppError({ message: unreadableMessage(path), cause: parsed.error })

  return parsed.data
}

// The message says the file is disposable, because that is the fix and it isn't obvious from the
// error. Losing it costs the suggestion to raise the cap, and nothing else.
function unreadableMessage(path: string): string {
  return `The override log at ${path} has a line that is not readable as one. Delete the file: it only feeds the review's suggestion to raise the cap, and it fills up again as you use --over-cap.`
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
