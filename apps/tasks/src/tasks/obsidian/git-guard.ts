import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError } from '@personal-automation/common/errors'

const run = promisify(execFile)

export type RevertCheck =
  | { kind: 'ok' }
  | { kind: 'not_a_repo' }
  | { kind: 'blocked'; untracked: string[]; modified: string[] }

/**
 * Whether every path the migration would rewrite could be restored with a single `git checkout`.
 *
 * The check is per file rather than whole-tree on purpose: the vault carries permanent uncommitted
 * churn under `.obsidian/plugins`, so a whole-tree cleanliness check would never pass and the
 * revert it protects would discard plugin state along with the migration.
 */
export async function checkRevertible({
  vaultPath,
  paths,
}: {
  vaultPath: string
  paths: string[]
}): Promise<RevertCheck> {
  if (!(await isGitRepo(vaultPath))) return { kind: 'not_a_repo' }
  if (paths.length === 0) return { kind: 'ok' }

  // --ignored=matching so a gitignored file reports as unrevertible rather than as clean: git
  // stays silent about ignored paths otherwise, which would read as "tracked and unchanged".
  const { stdout } = await run(
    'git',
    ['-C', vaultPath, 'status', '--porcelain', '-z', '--ignored=matching', '--', ...paths],
    { maxBuffer: 32 * 1024 * 1024 },
  )

  const untracked: string[] = []
  const modified: string[] = []
  for (const record of stdout.split('\0').filter(Boolean)) {
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (code === '??' || code === '!!') untracked.push(path)
    else modified.push(path)
  }
  if (untracked.length === 0 && modified.length === 0) return { kind: 'ok' }

  return { kind: 'blocked', untracked: untracked.sort(), modified: modified.sort() }
}

async function isGitRepo(vaultPath: string): Promise<boolean> {
  try {
    await run('git', ['-C', vaultPath, 'rev-parse', '--is-inside-work-tree'])

    return true
  } catch (err) {
    // A missing git binary is a broken setup, not an answer about the vault, so it surfaces.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new AppError({
        message:
          'git is not installed or not on PATH, so the vault cannot be checked for a safe revert.',
        cause: err,
      })
    }

    return false
  }
}
