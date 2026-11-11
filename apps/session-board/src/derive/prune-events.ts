import type { HookEvent } from '../events/types.js'
import type { MetadataBySession } from '../metadata/types.js'

const SECONDS_PER_DAY = 86_400

/**
 * The events still worth holding: every event of a session with a metadata
 * entry, and of any other session active within `keepDays`.
 *
 * A session with neither can never be drawn, and the log keeps every session
 * for as long as the hook has run, so without this the board holds and scans
 * months of them on every snapshot.
 */
export function pruneEvents({
  events,
  metadata,
  now,
  keepDays,
}: {
  events: HookEvent[]
  metadata: MetadataBySession
  /** Unix seconds. */
  now: number
  keepDays: number
}): HookEvent[] {
  const lastEventAt = new Map<string, number>()
  for (const event of events) lastEventAt.set(event.session_id, event.t)

  const since = now - keepDays * SECONDS_PER_DAY
  const kept = new Set(
    [...lastEventAt]
      .filter(([sessionId, t]) => metadata[sessionId] || t >= since)
      .map(([sessionId]) => sessionId),
  )
  if (kept.size === lastEventAt.size) return events

  return events.filter(event => kept.has(event.session_id))
}
