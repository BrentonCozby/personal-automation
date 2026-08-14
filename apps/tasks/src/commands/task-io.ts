import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fingerprintOf,
  lastTouchedOf,
  readTouchClock,
  reconcileTouchClock,
  recordFingerprint,
  recordTouch,
  type TouchClock,
  touchKey,
  writeTouchClock,
} from '../state/touch-clock.js'
import type { TaskState } from '../state/types.js'
import type { CapCandidate } from '../state/wip.js'
import { withDroppedMarker } from '../tasks/obsidian/markers.js'
import { rawOf, type ScannedTask, scanFileTasks } from '../tasks/obsidian/scan.js'
import { resolveScopedFiles } from '../tasks/obsidian/vault.js'
import { writeChangedLines } from '../tasks/obsidian/write.js'

/** A task as a message names it. */
export type TaskSummary = {
  title: string
  list: string
  /** From the touch clock; undefined when the clock has never seen this task. */
  lastTouched: Date | undefined
  due: Date | null
}

/** Outcomes of naming a task, shared by every command that takes a title. */
export type LookupFailure =
  | { kind: 'not_found'; query: string }
  | { kind: 'ambiguous'; query: string; matches: TaskSummary[] }

/** The vault moved underneath the command, so it wrote nothing. */
export type WriteFailure = { kind: 'conflict'; title: string; path: string }

/** A task no command may rewrite, and why. */
export type NotEditable =
  | { kind: 'not_editable'; title: string; reason: 'recurring' }
  | { kind: 'not_editable'; title: string; reason: 'terminal'; state: TaskState }
  | {
      kind: 'not_editable'
      title: string
      reason: 'conflicting'
      states: readonly TaskState[]
      path: string
      line: number
    }

/**
 * Reads the tasks in scope, brings the touch clock up to date against them, runs one command over
 * both, and saves the clock.
 *
 * The clock is saved whichever way the command goes, including when it refuses: noticing that a
 * task was edited is an observation about the vault, not a consequence of the command succeeding.
 * Reconciling over every open task rather than the command's own matches is required, because the
 * clock drops any key it isn't given.
 */
export async function withTaskClock<T>({
  vaultPath,
  scopes,
  clockPath,
  now,
  act,
}: {
  vaultPath: string
  scopes: readonly string[]
  clockPath: string
  now: Date
  act: (args: {
    /** Every task in scope, whatever its checkbox says. The done list is read from the closed ones. */
    tasks: ScannedTask[]
    open: ScannedTask[]
    clock: TouchClock
  }) => Promise<{ result: T; clock: TouchClock }>
}): Promise<T> {
  const tasks = await repairDroppedMarkers({
    vaultPath,
    tasks: await readTasks({ vaultPath, scopes }),
  })
  const open = openOf(tasks)
  const clock = reconcileTouchClock({
    stored: await readTouchClock(clockPath),
    tasks: open.map(task => ({ key: keyOf(task), fingerprint: fingerprintOf(task.raw) })),
    now,
  })

  const acted = await act({ tasks, open, clock })
  await writeTouchClock({ path: clockPath, clock: acted.clock })

  return acted.result
}

/**
 * Corrects the closing marker on every dropped task in scope, and returns the tasks as they now
 * read on disk.
 *
 * The Tasks plugin stamps `✅` on a dropped task, because the dropped status is typed `DONE` so that
 * dropping one occurrence of a recurring task still carries its rule forward. Left alone, the vault
 * would record a `✅` beside a cancelled checkbox.
 *
 * The touch clock is not involved: it holds open tasks only and prunes what it isn't given, so a
 * dropped task has no entry for this rewrite to disturb.
 *
 * A line that moved while the pass was reading it is skipped and picked up next time, rather than
 * failing whatever command asked for the read.
 */
export async function repairDroppedMarkers({
  vaultPath,
  tasks,
}: {
  vaultPath: string
  tasks: ScannedTask[]
}): Promise<ScannedTask[]> {
  const repaired: ScannedTask[] = []
  for (const task of tasks) {
    const after = task.status === 'cancelled' ? withDroppedMarker(task.lineText) : task.lineText
    if (after === task.lineText || !(await writeTaskLine({ vaultPath, task, after }))) {
      repaired.push(task)
      continue
    }
    repaired.push({ ...task, lineText: after, raw: rawOf({ lineText: after, notes: task.notes }) })
  }

  return repaired
}

/**
 * Every task in scope that has a title, whatever its checkbox says. A line holding nothing but
 * markers has no title to match on or to be identified by, so it is not a task anything here can
 * name.
 */
export async function readTasks({
  vaultPath,
  scopes,
}: {
  vaultPath: string
  scopes: readonly string[]
}): Promise<ScannedTask[]> {
  const files = await resolveScopedFiles({ vaultPath, scopes })
  const perFile = await Promise.all(
    files.map(async file => {
      const content = await readFile(file.absPath, 'utf8')

      return scanFileTasks({ path: file.relativePath, content })
    }),
  )

  return perFile.flat().filter(task => task.title !== '')
}

/** The live ones. A closed task is out of reach of every command and holds no place against the cap. */
export function openOf(tasks: readonly ScannedTask[]): ScannedTask[] {
  return tasks.filter(task => task.status === 'open')
}

/** Every open task in scope that has a title to be named by. */
export async function readOpenTasks({
  vaultPath,
  scopes,
}: {
  vaultPath: string
  scopes: readonly string[]
}): Promise<ScannedTask[]> {
  return openOf(await readTasks({ vaultPath, scopes }))
}

// Case-insensitive substring, except that an exact title wins outright. Without that, a task whose
// whole title appears inside a longer one could never be named on its own.
export function findMatches({
  open,
  query,
}: {
  open: ScannedTask[]
  query: string
}): ScannedTask[] {
  const wanted = query.trim().toLowerCase()
  const exact = open.filter(task => task.title.toLowerCase() === wanted)
  if (exact.length === 1) return exact

  return open.filter(task => task.title.toLowerCase().includes(wanted))
}

/**
 * Why this task can't be rewritten, or undefined when it can.
 *
 * Recurring tasks live outside the state model: the Tasks plugin manages them by recurrence rule
 * and due date, so writing a state or a date onto one would fight the plugin for control of it.
 * Terminal states are terminal, which is the whole of what they mean.
 *
 * A line carrying two state tags is refused rather than rewritten. Every write here clears the old
 * tags first, so acting on one would quietly discard whichever of the two the author didn't mean,
 * and there is nothing on the line that says which that is.
 */
export function notEditable(task: ScannedTask): NotEditable | undefined {
  if (task.states.length > 1) {
    return {
      kind: 'not_editable',
      title: task.title,
      reason: 'conflicting',
      states: task.states,
      path: task.path,
      line: task.lineNumber,
    }
  }
  if (task.isRecurring) return { kind: 'not_editable', title: task.title, reason: 'recurring' }
  if (task.state === 'done' || task.state === 'abandoned') {
    return { kind: 'not_editable', title: task.title, reason: 'terminal', state: task.state }
  }

  return undefined
}

/** Rewrites one task's line, leaving the rest of the file alone. False when nothing was written. */
export async function writeTaskLine({
  vaultPath,
  task,
  after,
}: {
  vaultPath: string
  task: ScannedTask
  after: string
}): Promise<boolean> {
  return await writeChangedLines({
    absPath: join(vaultPath, task.path),
    changes: [{ line: task.lineNumber, before: task.lineText, after }],
  })
}

/**
 * The clock with this task stamped as touched now, fingerprinted against the line as just written.
 *
 * Recording it here rather than leaving the next run to infer it is what makes the timestamp the
 * moment of the change. The fingerprint has to be built from the new line, or the next scan would
 * disagree with it and read the task as touched all over again.
 */
export function touchFor({
  clock,
  task,
  after,
  now,
}: {
  clock: TouchClock
  task: ScannedTask
  after: string
  now: Date
}): TouchClock {
  return recordTouch({
    clock,
    key: keyOf(task),
    fingerprint: fingerprintOf(rawOf({ lineText: after, notes: task.notes })),
    now,
  })
}

/**
 * The clock with this task's fingerprint moved to the line as just written, and its timestamp left
 * where it was.
 *
 * For a rewrite the user did not ask for, which today means decay. Without it the next scan would
 * read the app's own edit as a touch and reset the age it was judging.
 */
export function fingerprintFor({
  clock,
  task,
  after,
}: {
  clock: TouchClock
  task: ScannedTask
  after: string
}): TouchClock {
  return recordFingerprint({
    clock,
    key: keyOf(task),
    fingerprint: fingerprintOf(rawOf({ lineText: after, notes: task.notes })),
  })
}

export function keyOf(task: ScannedTask): string {
  return touchKey({ list: task.list, title: task.title })
}

/**
 * A task as both the state model reads it and the vault holds it.
 *
 * What every rule that judges a task and then rewrites its line needs: `toCandidate` drops the file
 * and line number the write has to have, so the scan result is carried alongside rather than
 * looked up again.
 */
export type ScannedCandidate = CapCandidate & { task: ScannedTask }

export function toCandidate({
  task,
  clock,
}: {
  task: ScannedTask
  clock: TouchClock
}): CapCandidate {
  return {
    title: task.title,
    list: task.list,
    status: task.status,
    isRecurring: task.isRecurring,
    state: task.state,
    due: task.due,
    lastTouched: lastTouchedOf({ clock, key: keyOf(task) }),
  }
}

export function toSummary(candidate: CapCandidate): TaskSummary {
  return {
    title: candidate.title,
    list: candidate.list,
    lastTouched: candidate.lastTouched,
    due: candidate.due,
  }
}

export function summarize({ task, clock }: { task: ScannedTask; clock: TouchClock }): TaskSummary {
  return toSummary(toCandidate({ task, clock }))
}
