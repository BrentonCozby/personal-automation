import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import { type ProcessInfo, resolveLiveSessions } from './liveness.js'

function event({
  sessionId,
  name,
  t,
  pid,
}: {
  sessionId: string
  name: string
  t: number
  pid?: number
}): HookEvent {
  return { session_id: sessionId, hook_event_name: name, t, ...(pid ? { hook_ppid: pid } : {}) }
}

function processes(...infos: ProcessInfo[]): Map<number, ProcessInfo> {
  return new Map(infos.map(info => [info.pid, info]))
}

it('counts a session with a running claude process as live', () => {
  const live = resolveLiveSessions({
    events: [event({ sessionId: 'abc', name: 'Stop', t: 200, pid: 4242 })],
    processes: processes({ pid: 4242, startedAt: 100, command: 'claude' }),
  })

  expect(live).toEqual(new Set(['abc']))
})

it('counts a session whose process is gone as dead', () => {
  const live = resolveLiveSessions({
    events: [event({ sessionId: 'abc', name: 'Stop', t: 200, pid: 4242 })],
    processes: processes(),
  })

  expect(live).toEqual(new Set())
})

it('ignores a live pid that is no longer a claude process', () => {
  const live = resolveLiveSessions({
    events: [event({ sessionId: 'abc', name: 'Stop', t: 200, pid: 4242 })],
    processes: processes({ pid: 4242, startedAt: 100, command: 'node' }),
  })

  expect(live).toEqual(new Set())
})

it('hands the process to the resumed session and drops the one left behind', () => {
  // The real sequence, timestamps and pid included: a throwaway session started
  // in a fresh tab, resumed another, and both reported pid 75555.
  const live = resolveLiveSessions({
    events: [
      event({ sessionId: 'f57f1d6b', name: 'SessionStart', t: 1_787_607_301, pid: 75_555 }),
      event({ sessionId: 'f57f1d6b', name: 'SessionEnd', t: 1_787_607_323, pid: 75_555 }),
      event({ sessionId: 'ca0c7db2', name: 'SessionStart', t: 1_787_607_323, pid: 75_555 }),
    ],
    processes: processes({ pid: 75_555, startedAt: 1_787_607_300, command: 'claude' }),
  })

  expect(live).toEqual(new Set(['ca0c7db2']))
})

it('hands the process over across a clear, which mints a new session id', () => {
  const live = resolveLiveSessions({
    events: [
      event({ sessionId: 'before', name: 'SessionEnd', t: 300, pid: 900 }),
      event({ sessionId: 'after', name: 'SessionStart', t: 300, pid: 900 }),
    ],
    processes: processes({ pid: 900, startedAt: 250, command: 'claude' }),
  })

  expect(live).toEqual(new Set(['after']))
})

it('drops a session whose pid was recycled onto a newer claude', () => {
  // The old session logged nothing after its process died, so it still owns the
  // pid. Only the start time gives it away.
  const live = resolveLiveSessions({
    events: [event({ sessionId: 'old', name: 'Stop', t: 100, pid: 512 })],
    processes: processes({ pid: 512, startedAt: 9000, command: 'claude' }),
  })

  expect(live).toEqual(new Set())
})

it('ignores a session that never reported a process', () => {
  const live = resolveLiveSessions({
    events: [event({ sessionId: 'abc', name: 'Stop', t: 200 })],
    processes: processes({ pid: 4242, startedAt: 100, command: 'claude' }),
  })

  expect(live).toEqual(new Set())
})

it('keeps two sessions in different processes both live', () => {
  const live = resolveLiveSessions({
    events: [
      event({ sessionId: 'one', name: 'Stop', t: 200, pid: 11 }),
      event({ sessionId: 'two', name: 'Stop', t: 201, pid: 22 }),
    ],
    processes: processes(
      { pid: 11, startedAt: 100, command: 'claude' },
      { pid: 22, startedAt: 100, command: 'claude' },
    ),
  })

  expect(live).toEqual(new Set(['one', 'two']))
})
