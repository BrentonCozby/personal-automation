import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEAVE_REASONS, type LeaveReason } from '../state/migration.js'
import { TASK_STATES, type TaskState } from '../state/types.js'
import { checkRevertible, type RevertCheck } from '../tasks/obsidian/git-guard.js'
import { type PlannedChange, planFileMigration } from '../tasks/obsidian/plan.js'
import { findMarkdownFiles } from '../tasks/obsidian/vault.js'
import { writeChangedLines } from '../tasks/obsidian/write.js'

export type VaultMigrationPlan = {
  scannedFiles: number
  /** Planned changes by target state. Absent keys mean zero. */
  counts: Partial<Record<TaskState, number>>
  /** Task lines deliberately left alone, by reason. Absent keys mean zero. */
  skipped: Partial<Record<LeaveReason, number>>
  changes: PlannedChange[]
}

export type MigrateResult =
  | { kind: 'dry_run'; plan: VaultMigrationPlan }
  | { kind: 'blocked'; check: RevertCheck; plan: VaultMigrationPlan }
  /** `conflicted` lists files that changed underneath the pass and were left untouched. */
  | { kind: 'applied'; plan: VaultMigrationPlan; written: string[]; conflicted: string[] }

/**
 * Reads the vault and works out every line the migration would rewrite. Writes nothing.
 *
 * `scopes` are the same file and folder paths the digest reads (TASK_LISTS), so the two can never
 * disagree about which checkboxes are tasks. Most checkboxes in the vault are not: they are steps
 * inside design docs, items in an imported note, or a reusable packing list. Passing no scope reads
 * the whole vault and is only ever right for a caller that has already decided that is what it
 * wants.
 */
export async function planVaultMigration({
  vaultPath,
  scopes,
}: {
  vaultPath: string
  scopes?: readonly string[]
}): Promise<VaultMigrationPlan> {
  const all = await findMarkdownFiles(vaultPath)
  const files =
    scopes && scopes.length > 0
      ? all.filter(path => scopes.some(scope => path === scope || path.startsWith(`${scope}/`)))
      : all

  const plan: VaultMigrationPlan = {
    scannedFiles: files.length,
    counts: {},
    skipped: {},
    changes: [],
  }

  for (const path of files) {
    const content = await readFile(join(vaultPath, path), 'utf8')
    const filePlan = planFileMigration({ path, content })
    plan.changes.push(...filePlan.changes)
    for (const state of TASK_STATES) {
      const count = filePlan.counts[state]
      if (count) plan.counts[state] = (plan.counts[state] || 0) + count
    }
    for (const reason of LEAVE_REASONS) {
      const count = filePlan.skipped[reason]
      if (count) plan.skipped[reason] = (plan.skipped[reason] || 0) + count
    }
  }

  return plan
}

/**
 * The one-time pass that gives every task a state tag. Dry by default: `isApply` is the only way
 * anything is written, and even then only once git confirms every file it would touch could be
 * restored in one command.
 */
export async function runMigrate({
  vaultPath,
  scopes,
  isApply,
}: {
  vaultPath: string
  scopes?: readonly string[]
  isApply: boolean
}): Promise<MigrateResult> {
  const plan = await planVaultMigration({ vaultPath, ...(scopes !== undefined ? { scopes } : {}) })
  if (!isApply || plan.changes.length === 0) return { kind: 'dry_run', plan }

  const paths = [...new Set(plan.changes.map(change => change.path))]
  const check = await checkRevertible({ vaultPath, paths })
  if (check.kind !== 'ok') return { kind: 'blocked', check, plan }

  const written: string[] = []
  const conflicted: string[] = []
  for (const path of paths) {
    const isWritten = await writeChangedLines({
      absPath: join(vaultPath, path),
      changes: plan.changes.filter(change => change.path === path),
    })
    if (isWritten) written.push(path)
    else conflicted.push(path)
  }

  return { kind: 'applied', plan, written, conflicted }
}
