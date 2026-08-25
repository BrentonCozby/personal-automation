import type { HookEvent } from '../events/types.js'

export interface ProcessInfo {
  pid: number
  /** Unix seconds, from `ps -o lstart=`. */
  startedAt: number
  command: string
}

const CLAUDE_COMMAND = 'claude'

/**
 * Which sessions still have a live Claude Code process behind them.
 *
 * A live pid is not enough on its own. Both `/clear` and a resume replace one
 * session with another inside the same process, so the session that was left
 * behind keeps pointing at a pid that is still very much alive. Three rules
 * together settle it:
 *
 * 1. The pid belongs to whichever session used it last. Ownership is exclusive.
 * 2. That pid is running now and is still a `claude` process.
 * 3. The process started no later than the owner's first event on that pid,
 *    which is impossible if the pid has since been recycled onto a new process.
 */
export function resolveLiveSessions({
  events,
  processes,
}: {
  events: HookEvent[]
  processes: Map<number, ProcessInfo>
}): Set<string> {
  const ownerByPid = new Map<number, string>()
  const firstSeenByPidAndSession = new Map<string, number>()

  for (const event of events) {
    const pid = event.hook_ppid
    if (pid === undefined) continue

    // Events arrive in write order, so the last assignment is the current owner.
    ownerByPid.set(pid, event.session_id)

    const key = `${pid}:${event.session_id}`
    if (!firstSeenByPidAndSession.has(key)) {
      firstSeenByPidAndSession.set(key, event.t)
    }
  }

  const live = new Set<string>()

  for (const [pid, sessionId] of ownerByPid) {
    const process = processes.get(pid)
    if (!process || process.command !== CLAUDE_COMMAND) continue

    const firstSeen = firstSeenByPidAndSession.get(`${pid}:${sessionId}`)
    if (firstSeen === undefined || process.startedAt > firstSeen) continue

    live.add(sessionId)
  }

  return live
}
