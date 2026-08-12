import { LEAVE_REASONS, type LeaveReason } from '../state/migration.js'
import { TASK_STATES, type TaskState } from '../state/types.js'
import type { PlannedChange } from '../tasks/obsidian/plan.js'
import type { VaultMigrationPlan } from './migrate.js'

const STATE_NOTE: Record<TaskState, string> = {
  someday: 'open, and nothing more is read into it',
  active: 'you pick these yourself',
  done: 'already checked off in Obsidian',
  abandoned: 'already cancelled in Obsidian',
}

const LEAVE_NOTE: Record<LeaveReason, string> = {
  recurring: 'the Tasks plugin already runs these on their own dates',
  'already finished': 'the checkbox already says so',
  'already tagged': 'a second pass changes nothing',
  'unknown status': 'a checkbox character this app has no rule for',
}

const RULE = '─'.repeat(58)

/** The console report for a migration pass, whether it was a dry run or actually written. */
export function renderMigrationReport({
  plan,
  isApplied,
}: {
  plan: VaultMigrationPlan
  isApplied: boolean
}): string {
  const sections = [
    isApplied ? 'Migration applied' : 'Migration plan',
    RULE,
    `Read ${plan.scannedFiles} ${plural(plan.scannedFiles, 'file')} in the vault.`,
  ]

  const tagged = sum(TASK_STATES.map(state => plan.counts[state] || 0))
  if (tagged === 0) {
    sections.push('', 'No task needs a new tag. Nothing to change.')
  } else {
    const verb = isApplied ? 'Tagged' : 'Would tag'
    sections.push('', `${verb} ${tagged} ${plural(tagged, 'task')}:`, renderCounts(plan))
  }

  const left = sum(LEAVE_REASONS.map(reason => plan.skipped[reason] || 0))
  if (left > 0)
    sections.push(
      '',
      `Leaving ${left} as ${plural(left, 'it is', 'they are')}:`,
      renderSkipped(plan),
    )

  sections.push('', 'Nothing moves to #active. Those are yours to pick, up to the cap.')

  if (plan.changes.length > 0) {
    sections.push(
      '',
      isApplied ? 'What changed:' : 'What would change:',
      renderChanges(plan.changes),
    )
  }

  sections.push('', isApplied ? renderAppliedFooter(plan) : renderDryRunFooter())

  return sections.join('\n')
}

function renderCounts(plan: VaultMigrationPlan): string {
  const rows = TASK_STATES.filter(state => plan.counts[state]).map(state => ({
    label: `#${state}`,
    count: plan.counts[state] || 0,
    note: STATE_NOTE[state],
  }))

  return renderRows(rows)
}

function renderSkipped(plan: VaultMigrationPlan): string {
  const rows = LEAVE_REASONS.filter(reason => plan.skipped[reason]).map(reason => ({
    label: reason,
    count: plan.skipped[reason] || 0,
    note: LEAVE_NOTE[reason],
  }))

  return renderRows(rows)
}

function renderRows(rows: { label: string; count: number; note: string }[]): string {
  const labelWidth = Math.max(...rows.map(row => row.label.length))
  const countWidth = Math.max(...rows.map(row => String(row.count).length))

  return rows
    .map(
      row =>
        `  ${row.label.padEnd(labelWidth)}  ${String(row.count).padStart(countWidth)}   ${row.note}`,
    )
    .join('\n')
}

// Grouped by file and sorted by line so the report reads in the same order as the file does.
function renderChanges(changes: PlannedChange[]): string {
  const byPath = new Map<string, PlannedChange[]>()
  for (const change of changes) {
    byPath.set(change.path, [...(byPath.get(change.path) || []), change])
  }

  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, forPath]) => {
      const sorted = [...forPath].sort((a, b) => a.line - b.line)
      const width = Math.max(...sorted.map(change => String(change.line).length))
      // The line number marks the current text and the arrow marks the replacement. Unified-diff
      // -/+ markers would sit directly in front of the `- [ ]` bullets and be unreadable.
      const lines = sorted.flatMap(change => [
        `  ${String(change.line).padStart(width)}   ${change.before}`,
        `  ${' '.repeat(width)} → ${change.after}`,
      ])

      return [`${path}`, ...lines].join('\n')
    })
    .join('\n\n')
}

function renderDryRunFooter(): string {
  return [
    'This was a dry run. The vault is untouched.',
    'Run it again with --apply to write it. Quit Obsidian first, so Sync',
    'cannot edit a file midway through the pass.',
  ].join('\n')
}

function renderAppliedFooter(plan: VaultMigrationPlan): string {
  const paths = [...new Set(plan.changes.map(change => change.path))].sort()

  return ['To undo the whole pass:', `  git checkout -- ${paths.join(' ')}`].join('\n')
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many
}
