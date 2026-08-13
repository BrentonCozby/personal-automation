import type { LeaveReason } from '../../state/migration.js'
import { migrationTargetFor } from '../../state/migration.js'
import type { TaskState } from '../../state/types.js'
import { scanFileTasks } from './scan.js'
import { withStateTag } from './tags.js'

export type PlannedChange = {
  path: string
  /** One-based, so it lines up with what an editor shows. */
  line: number
  before: string
  after: string
  state: TaskState
}

export type FileMigrationPlan = {
  changes: PlannedChange[]
  /** Planned changes by target state. Absent keys mean zero. */
  counts: Partial<Record<TaskState, number>>
  /** Task lines deliberately left alone, by reason. Absent keys mean zero. */
  skipped: Partial<Record<LeaveReason, number>>
}

/**
 * Works out which lines in one Markdown file the migration would rewrite. Pure: it reads content
 * and returns a plan, so the dry run and the apply share one code path and cannot disagree.
 *
 * Lines that are not tasks are passed over silently. They are the overwhelming majority of the
 * vault and are not the pass's business.
 */
export function planFileMigration({
  path,
  content,
}: {
  path: string
  content: string
}): FileMigrationPlan {
  const changes: PlannedChange[] = []
  const counts: Partial<Record<TaskState, number>> = {}
  const skipped: Partial<Record<LeaveReason, number>> = {}

  for (const task of scanFileTasks({ path, content })) {
    const target = migrationTargetFor({
      status: task.status,
      isRecurring: task.isRecurring,
      states: task.states,
    })
    if (target.kind === 'leave') {
      skipped[target.reason] = (skipped[target.reason] || 0) + 1
      continue
    }

    counts[target.state] = (counts[target.state] || 0) + 1
    changes.push({
      path,
      line: task.lineNumber,
      before: task.lineText,
      after: withStateTag({ line: task.lineText, state: target.state }),
      state: target.state,
    })
  }

  return { changes, counts, skipped }
}
