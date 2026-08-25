import { access } from 'node:fs/promises'
import type { Config } from './config.js'
import { type Board, buildBoard, findSessionsToAutoClaim } from './derive/board.js'
import { resolveCurrentSessionId, resolveSuccessors } from './derive/continuity.js'
import { resolveLiveSessions } from './derive/liveness.js'
import { listProcesses } from './derive/processes.js'
import { findProgressFiles, matchProgressFile, resolveRepoRoot } from './derive/progress-files.js'
import { findTranscriptSessionIds } from './derive/transcripts.js'
import type { HookEvent } from './events/types.js'
import type { MetadataStore } from './metadata/store.js'
import type { MetadataBySession } from './metadata/types.js'

/** How far back the Off the board drawer lists sessions you never claimed. */
const UNCLAIMED_WINDOW_DAYS = 7

const MILLISECONDS_PER_SECOND = 1000

function cwdBySession(events: HookEvent[]): Map<string, string> {
  const cwds = new Map<string, string>()

  for (const event of events) {
    if (event.cwd) cwds.set(event.session_id, event.cwd)
  }

  return cwds
}

/**
 * Where a session was last working.
 *
 * An imported session has no events to read a directory from, so it falls back
 * to the one stored on its row. Without that it can never be matched to a
 * progress file at all. Both the automatic matcher and the picker read the
 * directory through here so the picker cannot offer a different repository
 * than the one the matcher searched.
 */
export function resolveSessionCwd({
  events,
  metadata,
  sessionId,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
  sessionId: string
}): string | undefined {
  return cwdBySession(events).get(sessionId) || metadata[sessionId]?.cwd
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)

    return true
  } catch {
    return false
  }
}

async function findMissingProgressPaths(metadata: MetadataBySession): Promise<Set<string>> {
  const paths = [...new Set(Object.values(metadata).flatMap(entry => entry.progressPath ?? []))]
  const checks = await Promise.all(
    paths.map(async path => ({ path, exists: await fileExists(path) })),
  )

  return new Set(checks.filter(check => !check.exists).map(check => check.path))
}

/**
 * Link progress files to the claimed sessions that have none.
 *
 * A path already stored is never revisited, so a guess can never overwrite a
 * choice you made. Exact name matches are settled first across the whole repo,
 * because resolving one of them can leave exactly one file and one session
 * behind, which is what the second rule needs to fire.
 */
async function linkProgressFiles({
  events,
  metadata,
  store,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
  store: MetadataStore
}): Promise<boolean> {
  const unlinked = Object.entries(metadata).filter(([, entry]) => !entry.progressPath)

  const byRoot = new Map<string, { sessionId: string; name?: string | undefined }[]>()
  for (const [sessionId, entry] of unlinked) {
    const cwd = resolveSessionCwd({ events, metadata, sessionId })
    if (!cwd) continue

    const root = await resolveRepoRoot(cwd)
    if (!root) continue

    const sessions = byRoot.get(root) ?? []
    sessions.push({ sessionId, name: entry.name })
    byRoot.set(root, sessions)
  }

  let didLink = false

  for (const [root, sessions] of byRoot) {
    const candidates = await findProgressFiles(root)
    if (candidates.length === 0) continue

    const taken = new Set<string>()
    const stillUnlinked: typeof sessions = []

    for (const session of sessions) {
      const named = matchProgressFile({
        candidates: candidates.filter(candidate => !taken.has(candidate)),
        sessionName: session.name,
        // Only the exact-name rule may fire in this pass.
        unlinkedSessionCount: 0,
      })

      if (!named) {
        stillUnlinked.push(session)
        continue
      }

      taken.add(named)
      await store.patch({ sessionId: session.sessionId, changes: { progressPath: named } })
      didLink = true
    }

    const remaining = candidates.filter(candidate => !taken.has(candidate))
    const only = matchProgressFile({
      candidates: remaining,
      unlinkedSessionCount: stillUnlinked.length,
    })
    const lonelySession = stillUnlinked[0]

    if (only && lonelySession) {
      await store.patch({ sessionId: lonelySession.sessionId, changes: { progressPath: only } })
      didLink = true
    }
  }

  return didLink
}

/**
 * Move each row onto the session that took over from it.
 *
 * Clearing a session leaves its annotations on an id that is finished while the
 * live session starts blank, so the board would show a dead twin of everything
 * you clear. What you wrote belongs to the work, not to the id it started under.
 */
async function migrateSupersededSessions({
  metadata,
  store,
  successors,
  keptApart,
}: {
  metadata: MetadataBySession
  store: MetadataStore
  successors: Map<string, string>
  keptApart: Set<string>
}): Promise<boolean> {
  if (successors.size === 0) return false

  let didMigrate = false

  for (const [sessionId, entry] of Object.entries(metadata)) {
    if (keptApart.has(sessionId)) continue

    // A dismissed row holds no annotations to carry forward, and moving it
    // would stamp its marker onto the session that took over, taking a live row
    // off the board for no reason. It belongs where it is.
    if (entry.isDismissed) continue

    const current = resolveCurrentSessionId({ sessionId, successors })
    if (current === sessionId) continue

    // The successor may have already claimed itself from the name it inherited,
    // so anything it holds wins and the older row only fills the gaps.
    await store.patch({ sessionId: current, changes: { ...entry, ...metadata[current] } })
    await store.remove(sessionId)
    didMigrate = true
  }

  return didMigrate
}

/**
 * Ids that handed off but keep a row of their own anyway.
 *
 * A `/clear` that carried the same work forward and a `/clear` that started
 * different work in the same terminal produce identical events. A name on both
 * ends is the one signal that separates them: without this, the older row is
 * folded into the newer one, and since the newer one's own fields win,
 * everything written about the older session goes with nothing to show for it.
 *
 * Compares against the end of the chain, not the next link. Clearing twice with
 * a throwaway in the middle still lands the first session's row on the last
 * one, so a pairwise check would miss exactly the case it exists to catch.
 */
function findRowsToKeepApart({
  successors,
  metadata,
}: {
  successors: Map<string, string>
  metadata: MetadataBySession
}): Set<string> {
  const kept = new Set<string>()

  for (const sessionId of Object.keys(metadata)) {
    const current = resolveCurrentSessionId({ sessionId, successors })
    if (current === sessionId) continue

    if (metadata[sessionId]?.name && metadata[current]?.name) kept.add(sessionId)
  }

  return kept
}

export async function buildSnapshot({
  events,
  store,
  config,
  now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
}: {
  events: HookEvent[]
  store: MetadataStore
  config: Config
  now?: number
}): Promise<Board> {
  let metadata = await store.read()

  const successors = resolveSuccessors(events)
  const keptApart = findRowsToKeepApart({ successors, metadata })
  const isSuperseded = (sessionId: string): boolean =>
    !keptApart.has(sessionId) && resolveCurrentSessionId({ sessionId, successors }) !== sessionId

  const didMigrate = await migrateSupersededSessions({ metadata, store, successors, keptApart })
  if (didMigrate) metadata = await store.read()

  // A superseded id keeps its old `session_title` in the log forever, so
  // without this it claims itself straight back after the migration removed it.
  const claims = findSessionsToAutoClaim({ events, metadata }).filter(
    claim => !isSuperseded(claim.sessionId),
  )
  for (const claim of claims) {
    await store.patch({ sessionId: claim.sessionId, changes: { name: claim.name } })
  }

  const didLink = await linkProgressFiles({ events, metadata: await store.read(), store })
  if (claims.length > 0 || didLink || didMigrate) metadata = await store.read()

  const [processes, missingProgressPaths, transcriptSessionIds] = await Promise.all([
    listProcesses(),
    findMissingProgressPaths(metadata),
    findTranscriptSessionIds({ roots: config.transcriptRoots }),
  ])

  return buildBoard({
    events,
    metadata,
    supersededSessionIds: new Set([...successors.keys()].filter(id => !keptApart.has(id))),
    liveSessionIds: resolveLiveSessions({ events, processes }),
    missingProgressPaths,
    transcriptSessionIds,
    now,
    freshMinutes: config.freshMinutes,
    staleDays: config.staleDays,
    unclaimedWindowDays: UNCLAIMED_WINDOW_DAYS,
  })
}
