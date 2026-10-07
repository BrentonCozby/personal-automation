import type { HookEvent } from '../events/types.js'
import type { MetadataBySession, SessionMetadata } from '../metadata/types.js'
import { deriveActivity } from './activity.js'
import type { LastTurn } from './context-size.js'
import { progressSlug } from './progress-files.js'
import { findEventTitles } from './session-names.js'

/**
 * What colors a row.
 *
 * `ready` and `idle` are the same activity split by recency: a session that
 * went quiet a minute ago is your move, one that went quiet on Tuesday is not.
 */
export type RowStatus = 'running' | 'waiting' | 'ready' | 'idle' | 'gone'

export const UNGROUPED_LABEL = 'Ungrouped'

export interface BoardRow {
  sessionId: string
  name?: string | undefined
  /**
   * A name read out of the session itself, for a row you never named: the title
   * Claude Code recorded, or the first thing you asked it.
   *
   * Kept apart from `name` rather than filling it in, because naming a session
   * is what claims it. This is only ever drawn, never stored, so a row can say
   * what it was for while staying off the board.
   */
  derivedName?: string | undefined
  group?: string | undefined
  parkedReason?: string | undefined
  progressPath?: string | undefined
  /** The progress filename with `.progress.local.md` removed. */
  progressLabel?: string | undefined
  /** A linked file that is no longer on disk. Shown struck through, never dropped. */
  isProgressFileMissing: boolean
  /**
   * Claude Code has no transcript for this session, so `--resume` has nothing
   * to open. The row stays, since what you wrote about the work is still worth
   * reading, but it can never be resumed again.
   */
  isTranscriptMissing: boolean
  status: RowStatus
  /**
   * Unix seconds of the session's most recent event, or of the last write to
   * its transcript, whichever is later.
   */
  lastActive: number
  /**
   * What the session's most recent assistant turn sent to the model, cached
   * tokens included. Absent until the session has had one.
   */
  contextTokens?: number | undefined
  /**
   * Unix seconds of that same turn, which the prompt cache's countdown starts
   * from.
   */
  lastTurnAt?: number | undefined
  cwd?: string | undefined
}

export interface BoardGroup {
  name: string
  rows: BoardRow[]
}

export interface Board {
  groups: BoardGroup[]
  /** The Off the board drawer: sessions with no metadata row. Newest first. */
  unclaimed: BoardRow[]
  claimedCount: number
}

const SECONDS_PER_DAY = 86_400
const SECONDS_PER_MINUTE = 60

interface SessionEvents {
  sessionId: string
  events: HookEvent[]
}

function groupEventsBySession(events: HookEvent[]): SessionEvents[] {
  const bySession = new Map<string, HookEvent[]>()

  for (const event of events) {
    const existing = bySession.get(event.session_id)
    if (existing) {
      existing.push(event)
      continue
    }

    bySession.set(event.session_id, [event])
  }

  return [...bySession].map(([sessionId, sessionEvents]) => ({ sessionId, events: sessionEvents }))
}

function toBoardRow({
  sessionId,
  entry,
  derivedName,
  missingProgressPaths,
  transcriptTimes,
  lastTurns,
  status,
  lastActive,
  cwd,
}: {
  sessionId: string
  entry: SessionMetadata | undefined
  derivedName: string | undefined
  missingProgressPaths: Set<string>
  transcriptTimes: Map<string, number>
  lastTurns: Map<string, LastTurn>
  status: RowStatus
  lastActive: number
  cwd: string | undefined
}): BoardRow {
  const progressPath = entry?.progressPath
  const lastTurn = lastTurns.get(sessionId)

  return {
    sessionId,
    name: entry?.name,
    derivedName,
    group: entry?.group,
    parkedReason: entry?.parkedReason,
    progressPath,
    progressLabel: progressPath ? progressSlug(progressPath) : undefined,
    isProgressFileMissing: progressPath ? missingProgressPaths.has(progressPath) : false,
    isTranscriptMissing: !transcriptTimes.has(sessionId),
    status,
    lastActive,
    contextTokens: lastTurn?.tokens,
    lastTurnAt: lastTurn?.at,
    cwd,
  }
}

function lastDefined<T>({
  events,
  pick,
}: {
  events: HookEvent[]
  pick: (event: HookEvent) => T | undefined
}): T | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue

    const value = pick(event)
    if (value !== undefined) return value
  }

  return undefined
}

/**
 * Sessions that named themselves and have no row yet.
 *
 * `session_title` only ever holds the name passed to `claude -n`. The title
 * Claude writes from your first prompt reaches the terminal tab and stops
 * there, so there is no risk of claiming a session you never named.
 *
 * The name is kebab-cased on the way in, the same as one typed into the board,
 * because this write goes through `store.patch` and so misses the wire schema
 * that enforces the rule everywhere else.
 */
export function findSessionsToAutoClaim({
  events,
  metadata,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
}): { sessionId: string; name: string }[] {
  return [...findEventTitles({ events })]
    .filter(([sessionId]) => !metadata[sessionId])
    .map(([sessionId, name]) => ({ sessionId, name }))
}

export function buildBoard({
  events,
  metadata,
  knownGroups,
  liveSessionIds,
  missingProgressPaths,
  transcriptTimes,
  lastTurns = new Map(),
  supersededSessionIds = new Set(),
  derivedNames = new Map(),
  now,
  freshMinutes,
  unclaimedWindowDays,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
  /** Every group that exists, so one holding no sessions is still drawn. */
  knownGroups: string[]
  liveSessionIds: Set<string>
  missingProgressPaths: Set<string>
  /**
   * Sessions Claude Code still holds a transcript for, so `--resume` can work,
   * against the unix seconds each transcript was last written to.
   */
  transcriptTimes: Map<string, number>
  lastTurns?: Map<string, LastTurn>
  /**
   * Ids that handed their work to another session, through `/clear` or a
   * resume. They are previous identities of a live session rather than sessions
   * of their own, so they belong on neither the board nor the drawer.
   */
  supersededSessionIds?: Set<string>
  /** Names read out of the sessions themselves, for the rows nobody named. */
  derivedNames?: Map<string, string>
  /** Unix seconds. */
  now: number
  freshMinutes: number
  unclaimedWindowDays: number
}): Board {
  const claimedRows: { row: BoardRow; group: string; order: number | undefined }[] = []
  const unclaimed: BoardRow[] = []
  const sessionIdsWithEvents = new Set<string>()

  for (const { sessionId, events: sessionEvents } of groupEventsBySession(events)) {
    if (supersededSessionIds.has(sessionId)) continue

    sessionIdsWithEvents.add(sessionId)

    const lastEvent = sessionEvents.at(-1)
    if (!lastEvent) continue

    // A turn appends to the transcript as it runs, and a session stopped at a
    // permission prompt appends nothing until the prompt is answered.
    const wroteAt = transcriptTimes.get(sessionId) ?? 0
    const hasWrittenSince = wroteAt > lastEvent.t
    const lastActive = Math.max(lastEvent.t, wroteAt)
    const ageSeconds = Math.max(0, now - lastActive)
    const activity = deriveActivity(sessionEvents)
    const isAlive = liveSessionIds.has(sessionId)

    let status: RowStatus
    if (activity === 'ended' || !isAlive) {
      status = 'gone'
    } else if (activity === 'waiting' && hasWrittenSince) {
      status = 'running'
    } else if (activity === 'running' || activity === 'waiting') {
      status = activity
    } else {
      status = ageSeconds <= freshMinutes * SECONDS_PER_MINUTE ? 'ready' : 'idle'
    }

    const entry = metadata[sessionId]

    const row = toBoardRow({
      sessionId,
      entry,
      derivedName: derivedNames.get(sessionId),
      missingProgressPaths,
      transcriptTimes,
      lastTurns,
      status,
      lastActive,
      cwd: entry?.cwd || lastDefined({ events: sessionEvents, pick: event => event.cwd }),
    })

    // A dismissed row exists only to stop the session claiming itself again, so
    // it belongs in the drawer with the sessions that were never claimed.
    if (entry && !entry.isDismissed) {
      claimedRows.push({ row, group: entry.group ?? UNGROUPED_LABEL, order: entry.order })
      continue
    }

    if (ageSeconds > unclaimedWindowDays * SECONDS_PER_DAY) continue

    // A session nobody ever asked anything, and that Claude Code never titled
    // either, has nothing to say for itself: `/clear` writes one every time,
    // and every abandoned `claude` in a terminal leaves another. Twelve of the
    // twenty rows in the first real drawer were these, each drawn as "unnamed"
    // beside a path, and resuming one opens an empty conversation.
    //
    // The name decides it; the prompt count only rescues what the name misses,
    // so a session whose transcript cannot be read still keeps its row.
    const hasPrompt = sessionEvents.some(event => event.hook_event_name === 'UserPromptSubmit')
    if (!row.name && !row.derivedName && !hasPrompt) continue

    unclaimed.push(row)
  }

  // A session that went quiet before the hook started writing has no events to
  // build from, so its row comes from the import that carried it in. Always
  // `gone`: the log holds nothing that could say otherwise, and its age stops
  // moving until the session next fires a hook.
  for (const [sessionId, entry] of Object.entries(metadata)) {
    if (sessionIdsWithEvents.has(sessionId) || supersededSessionIds.has(sessionId)) continue
    if (entry.isDismissed) continue

    const lastActive = entry.lastActive
    if (!lastActive) continue

    claimedRows.push({
      row: toBoardRow({
        sessionId,
        entry,
        derivedName: derivedNames.get(sessionId),
        missingProgressPaths,
        transcriptTimes,
        lastTurns,
        status: 'gone',
        lastActive,
        cwd: entry.cwd,
      }),
      group: entry.group ?? UNGROUPED_LABEL,
      order: entry.order,
    })
  }

  // Seeded with the groups that exist, so one whose last session was moved out
  // stays on the board until it is deleted on purpose. Ungrouped is the absence
  // of a group rather than one of them, so it is never drawn empty.
  // Seeded in the file's order, which is the order groups are dragged into.
  const placedByGroup = new Map<string, PlacedRow[]>(
    knownGroups.filter(name => name !== UNGROUPED_LABEL).map(name => [name, []]),
  )
  for (const { row, group, order } of claimedRows) {
    const existing = placedByGroup.get(group)
    if (existing) {
      existing.push({ row, order })
      continue
    }

    placedByGroup.set(group, [{ row, order }])
  }

  const groups: BoardGroup[] = [...placedByGroup].map(([name, placed]) => ({
    name,
    rows: placed.sort(byPlacement).map(({ row }) => row),
  }))

  // Ungrouped is pinned last wherever the file would put it.
  groups.sort((a, b) => Number(a.name === UNGROUPED_LABEL) - Number(b.name === UNGROUPED_LABEL))

  return {
    groups,
    unclaimed: unclaimed.sort((a, b) => b.lastActive - a.lastActive),
    claimedCount: claimedRows.length,
  }
}

interface PlacedRow {
  row: BoardRow
  order: number | undefined
}

/**
 * Placed rows by their `order`, then the rows not placed yet, oldest first.
 *
 * A row goes unplaced only from its claim until the next snapshot gives it an
 * `order`, so the age fallback decides nothing for long.
 */
function byPlacement(a: PlacedRow, b: PlacedRow): number {
  if (a.order !== undefined && b.order !== undefined) return a.order - b.order
  if (a.order !== undefined) return -1
  if (b.order !== undefined) return 1

  return a.row.lastActive - b.row.lastActive
}
