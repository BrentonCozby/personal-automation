import { localIsoDate } from '../state/days.js'
import { defaultTouchClockPath } from '../state/touch-clock.js'
import { asCancelled } from '../tasks/obsidian/edits.js'
import {
  findMatches,
  type LookupFailure,
  type NotEditable,
  notEditable,
  summarize,
  type WriteFailure,
  withTaskClock,
  writeTaskLine,
} from './task-io.js'

export type AbandonResult =
  | LookupFailure
  | WriteFailure
  | NotEditable
  | { kind: 'abandoned'; title: string; list: string; date: string; wasActive: boolean }

/**
 * Drops one task for good, by cancelling its checkbox and stamping the plugin's `❌` date.
 *
 * No tag is written. The checkbox is the record, which is also why a task cancelled by hand in
 * Obsidian counts the same as one dropped here: both are a `[-]` box with a date, and the metric
 * that reports how much you deliberately let go reads exactly that.
 *
 * A cancelled task stops counting against the work-in-progress cap the moment its box closes, so
 * this is how you make room without finishing anything.
 */
export async function runAbandon({
  vaultPath,
  scopes,
  query,
  now = new Date(),
  clockPath = defaultTouchClockPath(),
}: {
  vaultPath: string
  scopes: readonly string[]
  query: string
  now?: Date
  clockPath?: string
}): Promise<AbandonResult> {
  return await withTaskClock<AbandonResult>({
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

      const date = localIsoDate(now)
      const after = asCancelled({ line: task.lineText, date })
      if (!(await writeTaskLine({ vaultPath, task, after }))) {
        return { result: { kind: 'conflict', title: task.title, path: task.path }, clock }
      }

      return {
        result: {
          kind: 'abandoned',
          title: task.title,
          list: task.list,
          date,
          wasActive: task.state === 'active',
        },
        // No touch recorded. The clock tracks open tasks, and this one's box just closed, so the
        // next run drops its entry rather than carrying a timestamp nothing will ever read.
        clock,
      }
    },
  })
}
