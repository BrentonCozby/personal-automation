import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '@personal-automation/common/errors'
import { z } from 'zod'
import { RUNS_DIR_NAME } from '../constants.js'

const VERSION = 1

// Resolved relative to this module (app dir), not CWD, so the clock always lands in
// apps/tasks/runs/, outside notify's apps/*/audit/* glob, which it would otherwise mail as errors.
const DEFAULT_PATH = join(
  fileURLToPath(new URL(`../../${RUNS_DIR_NAME}/`, import.meta.url)),
  'touch-clock.json',
)

const entrySchema = z.object({
  fingerprint: z.string().min(1),
  lastTouched: z.iso.datetime(),
})

const clockSchema = z.object({
  version: z.literal(VERSION),
  tasks: z.record(z.string(), entrySchema),
})

/**
 * When each task was last touched, stored outside the vault.
 *
 * Obsidian can't answer this on its own: there is no per-task last-modified anywhere in it. The
 * Tasks plugin's `➕` is creation and never changes, file modification time is per file while tasks
 * are per line, and the vault's git history is mechanical daily backup commits that start long
 * after the oldest task. So the clock is synthesized here: a fingerprint of each task's text plus
 * the time it last changed.
 *
 * The file holds nothing that doesn't exist elsewhere, so deleting it is safe. Doing so stamps
 * every task as touched now, which costs one stall window of signal and nothing else.
 */
export type TouchClock = z.infer<typeof clockSchema>

/** One task's fingerprint as this run sees it. */
export type TouchInput = {
  key: string
  fingerprint: string
}

export function emptyTouchClock(): TouchClock {
  return { version: VERSION, tasks: {} }
}

/** Where the clock is stored by default: `apps/tasks/runs/touch-clock.json`. */
export function defaultTouchClockPath(): string {
  return DEFAULT_PATH
}

/**
 * A task's identity: its list plus its title. `title` must already have its state tags stripped
 * (`ScannedTask.title` and `Task.title` both do), which is what lets a task keep its identity
 * through a promotion; otherwise adding `#active` would read as a brand new task.
 *
 * Editing a title does break identity, and the replacement is stamped as touched now. That is
 * correct: editing the title was itself a touch.
 */
export function touchKey({ list, title }: { list: string; title: string }): string {
  // JSON rather than a joined string: any separator character could appear in a list name or a
  // title, and two different tasks sharing a key would share a clock entry.
  return JSON.stringify([list, title])
}

/** A task's fingerprint. Any edit to the text this is given changes it, and so counts as a touch. */
export function fingerprintOf(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`
}

/**
 * The clock brought up to date against what the tasks look like now. A fingerprint that differs
 * from the stored one means the task was touched, so its timestamp becomes `now`; an unchanged one
 * carries the stored timestamp forward. A task the clock has never seen is stamped `now`, which is
 * also what makes the first run a clean cold start.
 *
 * Keys absent from `tasks` are dropped, so callers must pass every task in scope rather than a
 * filtered subset: passing only the `#active` ones would forget every other task's history.
 */
export function reconcileTouchClock({
  stored,
  tasks,
  now,
}: {
  stored: TouchClock
  tasks: readonly TouchInput[]
  now: Date
}): TouchClock {
  const lastTouched = now.toISOString()
  const reconciled: TouchClock['tasks'] = {}
  for (const task of tasks) {
    // First occurrence wins. Two tasks with the same list and title are one task to the clock;
    // letting the later one overwrite would flip the entry on every run, so neither could stall.
    if (reconciled[task.key]) continue
    const previous = stored.tasks[task.key]
    reconciled[task.key] =
      previous?.fingerprint === task.fingerprint
        ? previous
        : { fingerprint: task.fingerprint, lastTouched }
  }

  return { version: VERSION, tasks: reconciled }
}

/**
 * The clock with one task stamped as touched at `now`.
 *
 * Used when this app writes a state change itself, rather than waiting to infer the touch from the
 * next run's fingerprint. Promoting and scheduling are touches. Decay is not, because the user did
 * not touch it: stamping it would hide how long the task had been ignored. Decay uses
 * `recordFingerprint` instead.
 */
export function recordTouch({
  clock,
  key,
  fingerprint,
  now,
}: {
  clock: TouchClock
  key: string
  fingerprint: string
  now: Date
}): TouchClock {
  return {
    version: VERSION,
    tasks: { ...clock.tasks, [key]: { fingerprint, lastTouched: now.toISOString() } },
  }
}

/**
 * The clock with one task's fingerprint replaced and its timestamp carried forward.
 *
 * This is how a rewrite that is not a touch stays that way. `reconcileTouchClock` stamps `now` on
 * any task whose fingerprint has changed, so demoting a task by rewriting its line would make the
 * next pass read the demotion as work the user did.
 *
 * A key the clock has never seen is left absent rather than invented: nothing that rewrites a line
 * here can reach a task the clock does not already hold.
 */
export function recordFingerprint({
  clock,
  key,
  fingerprint,
}: {
  clock: TouchClock
  key: string
  fingerprint: string
}): TouchClock {
  const stored = clock.tasks[key]
  if (!stored) return clock

  return {
    version: VERSION,
    tasks: { ...clock.tasks, [key]: { fingerprint, lastTouched: stored.lastTouched } },
  }
}

/** When the task was last touched, or undefined when the clock has never seen it. */
export function lastTouchedOf({
  clock,
  key,
}: {
  clock: TouchClock
  key: string
}): Date | undefined {
  const stored = clock.tasks[key]
  if (!stored) return undefined

  return new Date(stored.lastTouched)
}

/** The stored clock, or an empty one when the file doesn't exist yet (the cold start). */
export async function readTouchClock(path: string): Promise<TouchClock> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (err) {
    if (isNotFound(err)) return emptyTouchClock()
    throw err
  }

  return parseTouchClock({ content, path })
}

/**
 * Writes the clock through a temporary file and renames it into place. A rename within one
 * filesystem is atomic, so a run killed mid-write leaves the previous clock intact rather than a
 * truncated file that the next run would reject.
 */
export async function writeTouchClock({
  path,
  clock,
}: {
  path: string
  clock: TouchClock
}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(clock, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

// A file that exists but can't be read is reported rather than silently replaced: it means
// something wrote to it that shouldn't have. The message says the file is disposable, because that
// is the fix and it isn't obvious from the error.
function parseTouchClock({ content, path }: { content: string; path: string }): TouchClock {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    throw new AppError({ message: unreadableMessage(path), cause: err })
  }

  const parsed = clockSchema.safeParse(json)
  if (!parsed.success) throw new AppError({ message: unreadableMessage(path), cause: parsed.error })

  return parsed.data
}

function unreadableMessage(path: string): string {
  return `The touch clock at ${path} is not readable as one. Delete it and it rebuilds on the next run, at the cost of one stall window: every task will read as touched today.`
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
