import { appendOverride } from '../overrides.js'
import { defaultTouchClockPath } from '../state/touch-clock.js'
import { countsTowardCap, orderByClosestToDone } from '../state/wip.js'
import { withStateTag } from '../tasks/obsidian/tags.js'
import {
  findMatches,
  type LookupFailure,
  type NotEditable,
  notEditable,
  summarize,
  type TaskSummary,
  toCandidate,
  toSummary,
  touchFor,
  type WriteFailure,
  withTaskClock,
  writeTaskLine,
} from './task-edit.js'

export type PromoteResult =
  | LookupFailure
  | WriteFailure
  | NotEditable
  | { kind: 'already_active'; title: string }
  | { kind: 'at_cap'; cap: number; active: TaskSummary[] }
  | {
      kind: 'promoted'
      title: string
      list: string
      /** Including the task just promoted. Exceeds `cap` only when `isOverCap`. */
      activeCount: number
      cap: number
      isOverCap: boolean
    }

/**
 * Moves one task to `#active`, if the cap has room for it.
 *
 * Reads the same files as the digest (TASK_LISTS), so the two can't disagree about which checkboxes
 * are tasks. Every outcome is a value rather than an exception, because "you are at the cap" and
 * "that matches three tasks" are ordinary answers the caller has to render, not failures.
 */
export async function runPromote({
  vaultPath,
  scopes,
  query,
  cap,
  isOverCap,
  now = new Date(),
  clockPath = defaultTouchClockPath(),
  runsDir,
}: {
  vaultPath: string
  scopes: readonly string[]
  query: string
  cap: number
  isOverCap: boolean
  now?: Date
  clockPath?: string
  runsDir?: string
}): Promise<PromoteResult> {
  return await withTaskClock<PromoteResult>({
    vaultPath,
    scopes,
    clockPath,
    now,
    act: async ({ open, clock }) => {
      const [task, ...rest] = findMatches({ open, query })
      if (!task) return { result: { kind: 'not_found', query }, clock }
      if (rest.length > 0) {
        const matches = [task, ...rest].map(match => summarize({ task: match, clock }))

        return { result: { kind: 'ambiguous', query, matches }, clock }
      }

      const blocked = notEditable(task)
      if (blocked) return { result: blocked, clock }
      if (task.state === 'active') {
        return { result: { kind: 'already_active', title: task.title }, clock }
      }

      const active = open
        .map(candidate => toCandidate({ task: candidate, clock }))
        .filter(countsTowardCap)
      const isAtCap = active.length >= cap
      if (isAtCap && !isOverCap) {
        const ordered = orderByClosestToDone(active).map(toSummary)

        return { result: { kind: 'at_cap', cap, active: ordered }, clock }
      }

      const after = withStateTag({ line: task.lineText, state: 'active' })
      if (!(await writeTaskLine({ vaultPath, task, after }))) {
        return { result: { kind: 'conflict', title: task.title, path: task.path }, clock }
      }

      if (isAtCap) {
        appendOverride({
          entry: {
            timestamp: now.toISOString(),
            title: task.title,
            list: task.list,
            cap,
            active_count: active.length,
          },
          ...(runsDir !== undefined ? { dir: runsDir } : {}),
        })
      }

      return {
        result: {
          kind: 'promoted',
          title: task.title,
          list: task.list,
          activeCount: active.length + 1,
          cap,
          isOverCap: isAtCap,
        },
        clock: touchFor({ clock, task, after, now }),
      }
    },
  })
}
