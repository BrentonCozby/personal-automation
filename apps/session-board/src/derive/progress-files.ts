import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { MetadataBySession } from '../metadata/types.js'

const execFileAsync = promisify(execFile)

const PROGRESS_SUFFIX = '.progress.local.md'

/**
 * The real repository root for a session's working directory.
 *
 * `--git-common-dir` is what makes this work for a worktree: it answers with
 * the main repository's `.git`, so the parent is the real root. `--show-toplevel`
 * would answer with the worktree instead, and progress files live at the real
 * root, so it would come back empty for exactly the long-running sessions that
 * most need one.
 *
 * Undefined means the directory is not inside a git repository.
 */
export async function resolveRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      cwd,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])

    return dirname(stdout.trim())
  } catch (error) {
    // A non-zero exit means "not a repository", an ordinary answer here. An
    // error carrying no exit status is something else (git missing, the
    // directory gone) and belongs to the caller.
    if (typeof (error as { code?: unknown }).code === 'number') return undefined

    throw error
  }
}

export async function findProgressFiles(repoRoot: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(repoRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []

    throw error
  }

  return entries
    .filter(entry => entry.endsWith(PROGRESS_SUFFIX))
    .sort()
    .map(entry => join(repoRoot, entry))
}

/** The filename with `.progress.local.md` removed, which is what a row shows. */
export function progressSlug(path: string): string {
  const filename = path.slice(path.lastIndexOf('/') + 1)

  return filename.endsWith(PROGRESS_SUFFIX) ? filename.slice(0, -PROGRESS_SUFFIX.length) : filename
}

export interface ProgressCandidate {
  path: string
  /** The filename with `.progress.local.md` removed, which is what the picker lists. */
  slug: string
  /**
   * The other session already using this file, so the picker can say so before
   * you put two sessions on one file. Its name, or its id when it has no name.
   * Undefined when the file is free, or when this session is the one using it.
   */
  linkedTo?: string | undefined
}

/**
 * Every progress file in a repository, marked with who is already using it.
 *
 * This is what the picker offers when automatic matching gives up. It never
 * filters a file out: two sessions on one task is a real thing to want, so a
 * file another session holds is offered with a warning rather than hidden.
 */
export async function listProgressCandidates({
  repoRoot,
  metadata,
  sessionId,
}: {
  repoRoot: string
  metadata: MetadataBySession
  sessionId: string
}): Promise<ProgressCandidate[]> {
  const holders = new Map<string, string>()
  for (const [id, entry] of Object.entries(metadata)) {
    if (id === sessionId || !entry.progressPath) continue

    holders.set(entry.progressPath, entry.name || id)
  }

  const paths = await findProgressFiles(repoRoot)

  return paths.map(path => ({
    path,
    slug: progressSlug(path),
    linkedTo: holders.get(path),
  }))
}

/**
 * Guess which progress file belongs to a session, or give up and let the user pick.
 *
 * The name match is exact on purpose. No prefix, substring, or fuzzy matching:
 * a wrong link is worse than none, because the file would be read as this
 * session's state and believed.
 */
export function matchProgressFile({
  candidates,
  sessionName,
  unlinkedSessionCount,
}: {
  candidates: string[]
  sessionName?: string | undefined
  /** Claimed sessions in this repo root that have no progress file linked yet. */
  unlinkedSessionCount: number
}): string | undefined {
  if (sessionName) {
    const named = candidates.find(candidate => progressSlug(candidate) === sessionName)
    if (named) return named
  }

  // With one file and one session wanting one, there is nothing to confuse.
  if (candidates.length === 1 && unlinkedSessionCount === 1) return candidates[0]

  return undefined
}
