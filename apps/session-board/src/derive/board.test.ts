import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import type { MetadataBySession } from '../metadata/types.js'
import { type Board, buildBoard, findSessionsToAutoClaim, UNGROUPED_LABEL } from './board.js'

const NOW = 1_800_000_000
const DAY = 86_400
const MINUTE = 60

function event({
  sessionId,
  name = 'Stop',
  agoSeconds = 0,
  ...rest
}: {
  sessionId: string
  name?: string
  agoSeconds?: number
} & Partial<HookEvent>): HookEvent {
  return { session_id: sessionId, hook_event_name: name, t: NOW - agoSeconds, ...rest }
}

function build({
  events,
  metadata = {},
  live = [],
  missing = [],
  superseded = [],
  transcripts,
  wroteAt = {},
  knownGroups = [],
}: {
  events: HookEvent[]
  metadata?: MetadataBySession
  live?: string[]
  missing?: string[]
  superseded?: string[]
  /** Left out means every session in the fixture has one, which is the normal case. */
  transcripts?: string[]
  /** Unix seconds a session's transcript was last written to. Zero unless said. */
  wroteAt?: Record<string, number>
  knownGroups?: string[]
}): Board {
  return buildBoard({
    events,
    metadata,
    knownGroups,
    liveSessionIds: new Set(live),
    missingProgressPaths: new Set(missing),
    transcriptTimes: new Map(
      (transcripts ?? [...events.map(event => event.session_id), ...Object.keys(metadata)]).map(
        sessionId => [sessionId, wroteAt[sessionId] ?? 0],
      ),
    ),
    supersededSessionIds: new Set(superseded),
    now: NOW,
    freshMinutes: 15,
    staleDays: 4,
    unclaimedWindowDays: 7,
  })
}

it('shows only claimed sessions on the board', () => {
  const board = build({
    events: [event({ sessionId: 'claimed' }), event({ sessionId: 'throwaway' })],
    metadata: { claimed: { name: 'impact' } },
    live: ['claimed', 'throwaway'],
  })

  expect(board.claimedCount).toBe(1)
  expect(board.groups.flatMap(group => group.rows).map(row => row.sessionId)).toEqual(['claimed'])
  expect(board.unclaimed.map(row => row.sessionId)).toEqual(['throwaway'])
})

it('builds a row for an imported session the event log has never seen', () => {
  const board = build({
    events: [],
    metadata: {
      imported: { name: 'SOC2', group: 'Bug week', lastActive: NOW - 3 * DAY, cwd: '/repo/soc2' },
    },
  })

  expect(board.groups).toEqual([
    {
      name: 'Bug week',
      rows: [expect.objectContaining({ sessionId: 'imported', status: 'gone', cwd: '/repo/soc2' })],
    },
  ])
  expect(board.groups[0]?.rows[0]?.lastActive).toBe(NOW - 3 * DAY)
})

it('leaves a hand-written metadata row off the board until something dates it', () => {
  const board = build({ events: [], metadata: { typed: { name: 'no timestamp' } } })

  expect(board.groups).toEqual([])
  expect(board.claimedCount).toBe(0)
})

it('dates a session from its events rather than the value it was imported with', () => {
  const board = build({
    events: [event({ sessionId: 'both', agoSeconds: 1 * MINUTE })],
    metadata: { both: { name: 'impact', lastActive: NOW - 10 * DAY } },
    live: ['both'],
  })

  const rows = board.groups.flatMap(group => group.rows)

  expect(rows).toHaveLength(1)
  expect(rows[0]?.lastActive).toBe(NOW - 1 * MINUTE)
})

it('keeps an imported row off the board when its id was superseded', () => {
  const board = build({
    events: [],
    metadata: { old: { name: 'handed over', lastActive: NOW - 2 * DAY } },
    superseded: ['old'],
  })

  expect(board.groups).toEqual([])
})

it('moves a dismissed session to the drawer instead of the board', () => {
  const board = build({
    events: [event({ sessionId: 'dropped' })],
    metadata: { dropped: { isDismissed: true } },
    live: ['dropped'],
  })

  expect(board.groups).toEqual([])
  expect(board.claimedCount).toBe(0)
  expect(board.unclaimed.map(row => row.sessionId)).toEqual(['dropped'])
})

it('leaves a dismissed session out of the auto-claim list', () => {
  const claims = findSessionsToAutoClaim({
    events: [event({ sessionId: 'dropped', session_title: 'code-gardener' })],
    metadata: { dropped: { isDismissed: true } },
  })

  expect(claims).toEqual([])
})

it('keeps a dismissed import off the board entirely, having no events to drawer it', () => {
  const board = build({
    events: [],
    metadata: { imported: { isDismissed: true, lastActive: NOW - 2 * DAY, cwd: '/repo' } },
  })

  expect(board.groups).toEqual([])
  expect(board.unclaimed).toEqual([])
})

it('drops an unclaimed session once it falls outside the drawer window', () => {
  const board = build({ events: [event({ sessionId: 'ancient', agoSeconds: 8 * DAY })] })

  expect(board.unclaimed).toEqual([])
})

it('sorts sessions inside a group oldest first', () => {
  const board = build({
    events: [
      event({ sessionId: 'recent', agoSeconds: 1 * DAY }),
      event({ sessionId: 'ancient', agoSeconds: 10 * DAY }),
      event({ sessionId: 'middle', agoSeconds: 5 * DAY }),
    ],
    metadata: {
      recent: { group: 'Bug week' },
      ancient: { group: 'Bug week' },
      middle: { group: 'Bug week' },
    },
  })

  expect(board.groups[0]?.rows.map(row => row.sessionId)).toEqual(['ancient', 'middle', 'recent'])
})

it('floats the group holding the most neglected session to the top', () => {
  const board = build({
    events: [
      event({ sessionId: 'a', agoSeconds: 2 * DAY }),
      event({ sessionId: 'b', agoSeconds: 10 * DAY }),
    ],
    metadata: { a: { group: 'Stash' }, b: { group: 'Bug week' } },
  })

  expect(board.groups.map(group => group.name)).toEqual(['Bug week', 'Stash'])
})

it('pins Ungrouped last however old its sessions are', () => {
  const board = build({
    events: [
      event({ sessionId: 'nogroup', agoSeconds: 30 * DAY }),
      event({ sessionId: 'grouped', agoSeconds: 1 * DAY }),
    ],
    metadata: { nogroup: { name: 'loose' }, grouped: { group: 'Bug week' } },
  })

  expect(board.groups.map(group => group.name)).toEqual(['Bug week', UNGROUPED_LABEL])
})

it('draws a group that holds no sessions, so taking the last one out cannot delete it', () => {
  const board = build({
    events: [event({ sessionId: 'grouped' })],
    metadata: { grouped: { group: 'Bug week' } },
    knownGroups: ['Bug week', 'Stash'],
  })

  expect(board.groups.map(group => group.name)).toEqual(['Bug week', 'Stash'])
  expect(board.groups[1]?.rows).toEqual([])
})

it('sorts an empty group below every group that has a session in it', () => {
  const board = build({
    events: [
      event({ sessionId: 'nogroup', agoSeconds: 30 * DAY }),
      event({ sessionId: 'grouped', agoSeconds: 1 * DAY }),
    ],
    metadata: { nogroup: { name: 'loose' }, grouped: { group: 'Bug week' } },
    knownGroups: ['Bug week', 'Stash'],
  })

  expect(board.groups.map(group => group.name)).toEqual(['Bug week', 'Stash', UNGROUPED_LABEL])
})

it('never draws Ungrouped as a group of its own, whatever the file says', () => {
  const board = build({
    events: [event({ sessionId: 'grouped' })],
    metadata: { grouped: { group: 'Bug week' } },
    knownGroups: [UNGROUPED_LABEL],
  })

  expect(board.groups.map(group => group.name)).toEqual(['Bug week'])
})

it('colors a session mid-turn as running', () => {
  const board = build({
    events: [event({ sessionId: 'a', name: 'UserPromptSubmit' })],
    metadata: { a: { name: 'x' } },
    live: ['a'],
  })

  expect(board.groups[0]?.rows[0]?.status).toBe('running')
})

it('colors a session blocked on a permission prompt as waiting', () => {
  const board = build({
    events: [
      event({ sessionId: 'a', name: 'Notification', notification_type: 'permission_prompt' }),
    ],
    metadata: { a: { name: 'x' } },
    live: ['a'],
  })

  expect(board.groups[0]?.rows[0]?.status).toBe('waiting')
})

it('reads a transcript written since the prompt as the prompt having been answered', () => {
  const board = build({
    events: [
      event({
        sessionId: 'a',
        name: 'Notification',
        notification_type: 'permission_prompt',
        agoSeconds: 30 * MINUTE,
      }),
    ],
    metadata: { a: { name: 'x' } },
    live: ['a'],
    wroteAt: { a: NOW - MINUTE },
  })

  expect(board.groups[0]?.rows[0]?.status).toBe('running')
  expect(board.groups[0]?.rows[0]?.lastActive).toBe(NOW - MINUTE)
})

it('stays waiting while the transcript is older than the prompt', () => {
  const board = build({
    events: [
      event({
        sessionId: 'a',
        name: 'Notification',
        notification_type: 'permission_prompt',
        agoSeconds: 30 * MINUTE,
      }),
    ],
    metadata: { a: { name: 'x' } },
    live: ['a'],
    wroteAt: { a: NOW - 31 * MINUTE },
  })

  expect(board.groups[0]?.rows[0]?.status).toBe('waiting')
  expect(board.groups[0]?.rows[0]?.lastActive).toBe(NOW - 30 * MINUTE)
})

it('splits idle into ready and idle on recency', () => {
  const justFinished = build({
    events: [event({ sessionId: 'a', agoSeconds: 5 * MINUTE })],
    metadata: { a: { name: 'x' } },
    live: ['a'],
  })
  const longQuiet = build({
    events: [event({ sessionId: 'a', agoSeconds: 3 * DAY })],
    metadata: { a: { name: 'x' } },
    live: ['a'],
  })

  expect(justFinished.groups[0]?.rows[0]?.status).toBe('ready')
  expect(longQuiet.groups[0]?.rows[0]?.status).toBe('idle')
})

it('marks a session whose process is gone as gone even if it never said goodbye', () => {
  // SIGKILL, a crash, and a reboot all emit nothing, so only the pid tells us.
  const board = build({
    events: [event({ sessionId: 'a', name: 'UserPromptSubmit' })],
    metadata: { a: { name: 'x' } },
    live: [],
  })

  expect(board.groups[0]?.rows[0]?.status).toBe('gone')
})

it('marks a session that ended cleanly as gone even while its process lives on', () => {
  // After /clear the process carries a different session, so the old id is over.
  const board = build({
    events: [event({ sessionId: 'a', name: 'SessionEnd', reason: 'clear' })],
    metadata: { a: { name: 'x' } },
    live: ['a'],
  })

  expect(board.groups[0]?.rows[0]?.status).toBe('gone')
})

it('sends the stale threshold and the timestamps, and judges neither', () => {
  const board = build({
    events: [
      event({ sessionId: 'fresh', agoSeconds: 3 * DAY }),
      event({ sessionId: 'stale', agoSeconds: 5 * DAY }),
    ],
    metadata: { fresh: { name: 'a' }, stale: { name: 'b' } },
  })

  const rows = board.groups[0]?.rows ?? []

  // Which side of the threshold a row falls on is the client's to work out on
  // every repaint. Deciding it here would freeze the answer at the moment the
  // frame was built, and frames can be minutes apart.
  expect(board.staleSeconds).toBe(4 * DAY)
  expect(rows.find(row => row.sessionId === 'fresh')?.lastActive).toBe(NOW - 3 * DAY)
  expect(rows.find(row => row.sessionId === 'stale')?.lastActive).toBe(NOW - 5 * DAY)
})

it('shows a progress file by slug alone', () => {
  const board = build({
    events: [event({ sessionId: 'a' })],
    metadata: { a: { name: 'x', progressPath: '/repo/mkpl-856-rollout.progress.local.md' } },
  })

  expect(board.groups[0]?.rows[0]?.progressLabel).toBe('mkpl-856-rollout')
  expect(board.groups[0]?.rows[0]?.isProgressFileMissing).toBe(false)
})

it('keeps a vanished progress file on the row and flags it', () => {
  const path = '/repo/gone.progress.local.md'
  const board = build({
    events: [event({ sessionId: 'a' })],
    metadata: { a: { name: 'x', progressPath: path } },
    missing: [path],
  })

  expect(board.groups[0]?.rows[0]?.progressLabel).toBe('gone')
  expect(board.groups[0]?.rows[0]?.isProgressFileMissing).toBe(true)
})

it('flags a session Claude Code has no transcript for', () => {
  const board = build({
    events: [event({ sessionId: 'a' }), event({ sessionId: 'b' })],
    metadata: { a: { name: 'has one' }, b: { name: 'lost it' } },
    transcripts: ['a'],
  })

  const rows = board.groups[0]?.rows ?? []

  expect(rows.find(row => row.sessionId === 'a')?.isTranscriptMissing).toBe(false)
  expect(rows.find(row => row.sessionId === 'b')?.isTranscriptMissing).toBe(true)
})

it('flags an imported row with no transcript, which has no events to judge it by', () => {
  const board = build({
    events: [],
    metadata: { imported: { name: 'from elsewhere', lastActive: NOW - 60, cwd: '/repo' } },
    transcripts: [],
  })

  expect(board.groups[0]?.rows[0]?.isTranscriptMissing).toBe(true)
})

it('takes the working directory from the newest event that carried one', () => {
  const board = build({
    events: [
      event({ sessionId: 'a', name: 'SessionStart', cwd: '/old', agoSeconds: 100 }),
      event({ sessionId: 'a', name: 'Stop', agoSeconds: 50 }),
    ],
    metadata: { a: { name: 'x' } },
  })

  expect(board.groups[0]?.rows[0]?.cwd).toBe('/old')
})

it('keeps a superseded id off both the board and the drawer', () => {
  // Clearing a session leaves an id that is a previous identity of a live one,
  // not a session in its own right. Showing it would double every clear.
  const board = build({
    events: [event({ sessionId: 'before' }), event({ sessionId: 'after' })],
    metadata: { after: { name: 'code-gardener' } },
    superseded: ['before'],
  })

  expect(board.groups.flatMap(group => group.rows).map(row => row.sessionId)).toEqual(['after'])
  expect(board.unclaimed).toEqual([])
  expect(board.claimedCount).toBe(1)
})

it('lists the drawer newest first', () => {
  const board = build({
    events: [
      event({ sessionId: 'older', agoSeconds: 2 * DAY }),
      event({ sessionId: 'newer', agoSeconds: 1 * DAY }),
    ],
  })

  expect(board.unclaimed.map(row => row.sessionId)).toEqual(['newer', 'older'])
})

it('claims a session that named itself with -n', () => {
  const claims = findSessionsToAutoClaim({
    events: [event({ sessionId: 'a', name: 'SessionStart', session_title: 'bme-orders' })],
    metadata: {},
  })

  expect(claims).toEqual([{ sessionId: 'a', name: 'bme-orders' }])
})

it('leaves an already-claimed session alone so a rename in the UI sticks', () => {
  const claims = findSessionsToAutoClaim({
    events: [event({ sessionId: 'a', name: 'SessionStart', session_title: 'bme-orders' })],
    metadata: { a: { name: 'renamed by hand' } },
  })

  expect(claims).toEqual([])
})

it('claims nothing for a session that was never named', () => {
  const claims = findSessionsToAutoClaim({
    events: [event({ sessionId: 'a', name: 'SessionStart' })],
    metadata: {},
  })

  expect(claims).toEqual([])
})

it('kebab-cases a title so an auto-claimed name can still match a progress file', () => {
  const claims = findSessionsToAutoClaim({
    events: [event({ sessionId: 'a', name: 'SessionStart', session_title: 'Bug Week' })],
    metadata: {},
  })

  expect(claims).toEqual([{ sessionId: 'a', name: 'bug-week' }])
})

it('claims nothing for a title with no kebab-case name in it', () => {
  const claims = findSessionsToAutoClaim({
    events: [event({ sessionId: 'a', name: 'SessionStart', session_title: '!!!' })],
    metadata: {},
  })

  expect(claims).toEqual([])
})
