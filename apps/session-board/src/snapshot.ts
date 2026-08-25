import { access } from 'node:fs/promises'
import type { Config } from './config.js'
import { type Board, buildBoard, findSessionsToAutoClaim } from './derive/board.js'
import {
  PLACEHOLDER_ID_PREFIX,
  RELAUNCH_WINDOW_SECONDS,
  resolveCurrentSessionId,
  resolveRelaunchSuccessors,
  resolveSuccessors,
} from './derive/continuity.js'
import { resolveLiveSessions } from './derive/liveness.js'
import { listProcesses } from './derive/processes.js'
import { findProgressFiles, matchProgressFile, resolveRepoRoot } from './derive/progress-files.js'
import { cwdBySession } from './derive/repos.js'
import {
  createSessionNamer,
  findEventTitles,
  findTranscriptPaths,
  type SessionNamer,
} from './derive/session-names.js'
import { findTranscripts } from './derive/transcripts.js'
import type { HookEvent } from './events/types.js'
import type { GroupStore } from './metadata/group-store.js'
import type { MetadataStore } from './metadata/store.js'
import type { MetadataBySession } from './metadata/types.js'

/** How far back the Off the board drawer lists sessions you never claimed. */
const UNCLAIMED_WINDOW_DAYS = 7

const MILLISECONDS_PER_SECOND = 1000

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
  const unlinked = Object.entries(metadata).filter(
    // A dismissed row is off the board and a superseded one is an empty
    // pointer. Neither is ever drawn, so neither can show a link, and each one
    // left in here costs a `git rev-parse` on every snapshot to work out a
    // repository nothing will read. On the real board that was all 19 of the
    // rows without a path, and half a second of every snapshot.
    ([, entry]) => !entry.progressPath && !entry.isDismissed && !entry.supersededBy,
  )

  const cwdBySessionId = new Map<string, string>()
  for (const [sessionId] of unlinked) {
    const cwd = resolveSessionCwd({ events, metadata, sessionId })
    if (cwd) cwdBySessionId.set(sessionId, cwd)
  }

  // One `git rev-parse` per directory rather than per session, and all of them
  // at once: sessions working in one repository share the answer.
  const rootByCwd = new Map(
    await Promise.all(
      [...new Set(cwdBySessionId.values())].map(
        async cwd => [cwd, await resolveRepoRoot(cwd)] as const,
      ),
    ),
  )

  const byRoot = new Map<string, { sessionId: string; name?: string | undefined }[]>()
  for (const [sessionId, entry] of unlinked) {
    const cwd = cwdBySessionId.get(sessionId)
    const root = cwd === undefined ? undefined : rootByCwd.get(cwd)
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
  relaunched,
}: {
  metadata: MetadataBySession
  store: MetadataStore
  successors: Map<string, string>
  keptApart: Set<string>
  relaunched: Set<string>
}): Promise<boolean> {
  if (successors.size === 0) return false

  let didMigrate = false

  for (const [sessionId, entry] of Object.entries(metadata)) {
    if (keptApart.has(sessionId)) continue

    // A dismissed row holds no annotations to carry forward, and moving it
    // would stamp its marker onto the session that took over, taking a live row
    // off the board for no reason. It belongs where it is.
    if (entry.isDismissed) continue

    // Already migrated, and all that is left is the pointer saying so. Running
    // it through again would rewrite the file on every snapshot, and each write
    // wakes the watcher that asks for the next one.
    if (entry.supersededBy) continue

    const current = resolveCurrentSessionId({ sessionId, successors })
    if (current === sessionId) continue

    // The mark that paired these two belongs to the row that was clicked, not
    // to the session it started. Carrying it forward would let the new row
    // adopt a third session started under the same name minutes later.
    const { relaunchedAt: _relaunched, ...carried } = entry

    // The successor may have already claimed itself from the name it inherited,
    // so anything it holds wins and the older row only fills the gaps.
    await store.patch({ sessionId: current, changes: { ...carried, ...metadata[current] } })
    await store.remove(sessionId)

    // A `/clear` handover is written in the event log, so removing the row
    // loses nothing. A relaunch is recorded nowhere else, and the id it leaves
    // behind was launched with a name, so an empty row has to stay to say where
    // its work went. It draws nothing: `buildBoard` skips a superseded id.
    if (relaunched.has(sessionId)) {
      await store.patch({ sessionId, changes: { supersededBy: current } })
    }

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
 *
 * A row you relaunched yourself is never kept apart. The ambiguity this guards
 * against belongs to `/clear`, which cannot say whether the new session carries
 * the same work; clicking resume says so outright, and both ends carry the same
 * name by design because the board passes it to the new session.
 */
function findRowsToKeepApart({
  successors,
  metadata,
  relaunched,
}: {
  successors: Map<string, string>
  metadata: MetadataBySession
  relaunched: Set<string>
}): Set<string> {
  const kept = new Set<string>()

  for (const sessionId of Object.keys(metadata)) {
    if (relaunched.has(sessionId)) continue

    const current = resolveCurrentSessionId({ sessionId, successors })
    if (current === sessionId) continue

    if (metadata[sessionId]?.name && metadata[current]?.name) kept.add(sessionId)
  }

  return kept
}

/**
 * Drop the rows the board wrote for a session that never turned up.
 *
 * A row waits under a placeholder id until the session it asked for fires its
 * first hook and the pairing hands the row over. Past the pairing window no
 * session can take it any more: it has no events of its own and no `lastActive`
 * either, so it draws nothing at all, and left in the file it holds its name
 * against every later attempt with no row on screen to delete.
 */
async function dropUnpairedPlaceholders({
  events,
  metadata,
  store,
  relaunches,
  now,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
  store: MetadataStore
  relaunches: Map<string, string>
  now: number
}): Promise<boolean> {
  const sessionIdsWithEvents = new Set(events.map(event => event.session_id))
  let didDrop = false

  for (const [sessionId, entry] of Object.entries(metadata)) {
    if (!sessionId.startsWith(PLACEHOLDER_ID_PREFIX)) continue
    // Paired, whether that happened on this snapshot or on an earlier one: the
    // pairing reads `supersededBy` back out of the file.
    if (relaunches.has(sessionId)) continue
    if (sessionIdsWithEvents.has(sessionId) || entry.lastActive) continue

    const { relaunchedAt } = entry
    if (relaunchedAt && now - relaunchedAt <= RELAUNCH_WINDOW_SECONDS) continue

    await store.remove(sessionId)
    didDrop = true
  }

  return didDrop
}

export async function buildSnapshot({
  events,
  store,
  groups,
  config,
  namer = createSessionNamer(),
  now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
}: {
  events: HookEvent[]
  store: MetadataStore
  groups: GroupStore
  config: Config
  /**
   * Holds the transcript it read for each session, so pass the same one every
   * time. A fresh namer per snapshot re-reads one file per unnamed row, every
   * thirty seconds, for an answer that cannot change.
   */
  namer?: SessionNamer
  now?: number
}): Promise<Board> {
  let metadata = await store.read()

  const relaunches = resolveRelaunchSuccessors({ events, metadata })
  const didDrop = await dropUnpairedPlaceholders({ events, metadata, store, relaunches, now })
  if (didDrop) metadata = await store.read()

  const successors = new Map([...resolveSuccessors(events), ...relaunches])
  const keptApart = findRowsToKeepApart({
    successors,
    metadata,
    relaunched: new Set(relaunches.keys()),
  })
  const isSuperseded = (sessionId: string): boolean =>
    !keptApart.has(sessionId) && resolveCurrentSessionId({ sessionId, successors }) !== sessionId

  const didMigrate = await migrateSupersededSessions({
    metadata,
    store,
    successors,
    keptApart,
    relaunched: new Set(relaunches.keys()),
  })
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

  // A group named on a row but never created through the board still has to
  // survive its last session being moved out, so every name met here is taken
  // as a group that exists.
  await groups.register(
    Object.values(metadata)
      .map(entry => entry.group)
      .filter(name => name !== undefined),
  )

  // Only for the rows you never named: a name you typed always wins, so
  // reading a transcript to second-guess it would be work thrown away.
  const transcriptPaths = findTranscriptPaths({ events })
  const titles = findEventTitles({ events })
  const unnamed = [...new Set(events.map(event => event.session_id))]
    .filter(sessionId => !metadata[sessionId]?.name)
    .map(sessionId => ({
      sessionId,
      transcriptPaths: transcriptPaths.get(sessionId) ?? [],
      title: titles.get(sessionId),
    }))

  const [processes, missingProgressPaths, transcriptTimes, knownGroups, derivedNames] =
    await Promise.all([
      listProcesses(),
      findMissingProgressPaths(metadata),
      findTranscripts({ roots: config.transcriptRoots }),
      groups.read(),
      namer.derive({ sessions: unnamed }),
    ])

  return buildBoard({
    events,
    metadata,
    knownGroups,
    derivedNames,
    supersededSessionIds: new Set([...successors.keys()].filter(id => !keptApart.has(id))),
    liveSessionIds: resolveLiveSessions({ events, processes }),
    missingProgressPaths,
    transcriptTimes,
    now,
    freshMinutes: config.freshMinutes,
    staleDays: config.staleDays,
    unclaimedWindowDays: UNCLAIMED_WINDOW_DAYS,
  })
}
