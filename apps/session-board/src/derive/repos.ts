import type { HookEvent } from '../events/types.js'
import type { MetadataBySession } from '../metadata/types.js'
import { resolveRepoRoot } from './progress-files.js'

/** Where each session was last working, by session id. */
export function cwdBySession(events: HookEvent[]): Map<string, string> {
  const cwds = new Map<string, string>()

  for (const event of events) {
    if (event.cwd) cwds.set(event.session_id, event.cwd)
  }

  return cwds
}

/**
 * Every directory the board has ever seen a session in.
 *
 * Both sources are read: the event log covers every session that has fired a
 * hook, and a row's own `cwd` covers one imported from elsewhere that the log
 * has never seen.
 */
export function collectSessionDirectories({
  events,
  metadata,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
}): string[] {
  const directories = new Set<string>()

  for (const event of events) if (event.cwd) directories.add(event.cwd)
  for (const entry of Object.values(metadata)) if (entry.cwd) directories.add(entry.cwd)

  return [...directories]
}

/**
 * The directories the sessions in one group work in.
 *
 * Which is what makes the first suggestion for a new session the repository
 * that group is about, rather than the one the whole board uses most. Measured
 * on the real board: the two differ for four of the six named groups.
 */
export function collectGroupDirectories({
  events,
  metadata,
  group,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
  group: string
}): string[] {
  const cwds = cwdBySession(events)
  const directories = new Set<string>()

  for (const [sessionId, entry] of Object.entries(metadata)) {
    if (entry.group !== group) continue

    const cwd = cwds.get(sessionId) || entry.cwd
    if (cwd) directories.add(cwd)
  }

  return [...directories]
}

// Scratch repositories a probe left behind. Every throwaway path in the real
// log is under one of these two, and the trailing slash is what keeps a real
// directory called /tmpfiles out of it.
const THROWAWAY_PREFIXES = ['/tmp/', '/private/tmp/']

/** Whether a repository is scratch, so it is never offered as somewhere to work. */
export function isThrowawayRoot(root: string): boolean {
  return THROWAWAY_PREFIXES.some(prefix => root.startsWith(prefix))
}

export interface RepoRoots {
  /**
   * The repository roots a new session could be started in, most used first.
   *
   * Roots, never worktrees: a progress file lives at the real root, so a session
   * tied to one worktree cannot keep its state where the rest of the
   * repository's sessions keep theirs. `resolveRepoRoot` is what collapses a
   * worktree or a subdirectory onto the repository it belongs to, which also
   * means a repository the board has only ever seen through a worktree is still
   * offered.
   *
   * A directory that resolves to nothing is dropped, which covers both a path in
   * no repository and a worktree that has since been removed from disk.
   *
   * Ordered by how many directories collapsed onto each root, so the repository
   * the most work happens in is the first suggestion. Ties break on the path, or
   * the list would reorder itself between two requests that asked the same
   * thing.
   */
  list(directories: string[]): Promise<string[]>
}

/**
 * A lookup from a session's directory to the repository root it belongs to.
 *
 * Held for the life of the board, because each answer costs a `git` process and
 * the start panel asks about every directory the board has ever seen: 76 of
 * them on the real log, twice per request, which left the panel's repository
 * field disabled for 430–1130ms after every open.
 *
 * "In no repository" is remembered too, and that is where the cost of
 * remembering lands: 28 of those 76 are in no repository (12 no longer on disk,
 * 16 there but not repositories), and a `git init` in one of them stays out of
 * the suggestions until the board restarts. The field takes a typed path either
 * way.
 */
export function createRepoRoots(): RepoRoots {
  const rootByDirectory = new Map<string, string | undefined>()

  async function resolve(directory: string): Promise<string | undefined> {
    // `has`, not a truthy check on the value: `undefined` is an answer here,
    // and reading it as a miss would spawn git again for every directory that
    // is in no repository.
    if (rootByDirectory.has(directory)) return rootByDirectory.get(directory)

    const root = await resolveRepoRoot(directory)
    rootByDirectory.set(directory, root)

    return root
  }

  async function list(directories: string[]): Promise<string[]> {
    const resolved = await Promise.all(directories.map(directory => resolve(directory)))

    const counts = new Map<string, number>()
    for (const root of resolved) {
      if (!root || isThrowawayRoot(root)) continue
      counts.set(root, (counts.get(root) ?? 0) + 1)
    }

    return [...counts]
      .sort(([leftRoot, leftCount], [rightRoot, rightCount]) =>
        leftCount === rightCount ? leftRoot.localeCompare(rightRoot) : rightCount - leftCount,
      )
      .map(([root]) => root)
  }

  return { list }
}
