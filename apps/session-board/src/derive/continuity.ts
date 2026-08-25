import type { HookEvent } from '../events/types.js'
import type { MetadataBySession } from '../metadata/types.js'

// The reasons Claude Code hands one session's process to another. `/clear`
// mints a fresh session id in the same process, and resuming does the same when
// you resume from inside another session.
const HANDOVER = new Set(['clear', 'resume'])

/**
 * Map each session id to the session that took over from it.
 *
 * Without this, clearing a session strands everything you wrote about it. The
 * old id keeps the name, group, parked reason and progress file while the live
 * session starts blank, so the board grows a dead twin of every session you
 * clear. The pairing is not a guess: the same process reports SessionEnd with a
 * handover reason and then SessionStart with the matching source.
 */
// The two halves of a handover are not written in a fixed order. Clearing
// `code-gardener` wrote the new SessionStart before the old SessionEnd, while
// clearing `bme-orders` a minute later wrote them the other way round, so the
// pair has to be matched on the process and the clock rather than on sequence.
const PAIR_WINDOW_SECONDS = 5

interface Pending {
  sessionId: string
  t: number
}

function pairs({ event, waiting }: { event: HookEvent; waiting: Pending | undefined }): boolean {
  if (!waiting || waiting.sessionId === event.session_id) return false

  return Math.abs(event.t - waiting.t) <= PAIR_WINDOW_SECONDS
}

export function resolveSuccessors(events: HookEvent[]): Map<string, string> {
  const endedOnPid = new Map<number, Pending>()
  const startedOnPid = new Map<number, Pending>()
  const successor = new Map<string, string>()

  for (const event of events) {
    const pid = event.hook_ppid
    if (pid === undefined) continue

    if (event.hook_event_name === 'SessionEnd') {
      if (!event.reason || !HANDOVER.has(event.reason)) continue

      const waiting = startedOnPid.get(pid)
      if (pairs({ event, waiting }) && waiting) {
        successor.set(event.session_id, waiting.sessionId)
        startedOnPid.delete(pid)
        continue
      }

      endedOnPid.set(pid, { sessionId: event.session_id, t: event.t })
      continue
    }

    if (event.hook_event_name !== 'SessionStart') continue
    if (!event.source || !HANDOVER.has(event.source)) continue

    const waiting = endedOnPid.get(pid)
    if (pairs({ event, waiting }) && waiting) {
      successor.set(waiting.sessionId, event.session_id)
      endedOnPid.delete(pid)
      continue
    }

    startedOnPid.set(pid, { sessionId: event.session_id, t: event.t })
  }

  return successor
}

/**
 * How long after a resume click a new session may start and still be counted as
 * the same work.
 *
 * The tab opens in about a second. The rest of the window covers a slow login
 * shell, and it is short enough that a `claude -n <the same name>` you start by
 * hand later in the day is not swallowed into the row.
 */
const RELAUNCH_WINDOW_SECONDS = 300

/**
 * Map a relaunched row to the session the board just started for it.
 *
 * Resuming a row that has a progress file opens a brand new session rather than
 * the old conversation, so the two ids share no process and `resolveSuccessors`
 * cannot see the link. Without this the new session claims itself from the name
 * it was given and lands in Ungrouped, while the row you clicked stays behind in
 * its group: the same name twice, once live and once dead.
 */
export function resolveRelaunchSuccessors({
  events,
  metadata,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
}): Map<string, string> {
  const successor = new Map<string, string>()
  const taken = new Set<string>()

  for (const [sessionId, entry] of Object.entries(metadata)) {
    const { relaunchedAt, name } = entry
    if (!relaunchedAt || !name) continue

    const started = events.find(
      event =>
        event.hook_event_name === 'SessionStart' &&
        event.session_title === name &&
        event.session_id !== sessionId &&
        !taken.has(event.session_id) &&
        event.t >= relaunchedAt &&
        event.t <= relaunchedAt + RELAUNCH_WINDOW_SECONDS,
    )
    if (!started) continue

    successor.set(sessionId, started.session_id)
    taken.add(started.session_id)
  }

  return successor
}

/**
 * Follow a chain of handovers to the session that is current now.
 *
 * Clearing twice makes a chain, so the first id has to walk all the way to the
 * last. The seen set stops a cycle from spinning, which malformed or replayed
 * events could otherwise produce.
 */
export function resolveCurrentSessionId({
  sessionId,
  successors,
}: {
  sessionId: string
  successors: Map<string, string>
}): string {
  const seen = new Set([sessionId])
  let current = sessionId

  for (;;) {
    const next = successors.get(current)
    if (!next || seen.has(next)) return current

    seen.add(next)
    current = next
  }
}
