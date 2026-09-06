import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import type { Config } from './config.js'
import { listProcesses } from './derive/processes.js'
import type { HookEvent } from './events/types.js'
import { createGroupStore } from './metadata/group-store.js'
import { createMetadataStore } from './metadata/store.js'
import type { MetadataBySession } from './metadata/types.js'
import { buildSnapshot } from './snapshot.js'

const NOW = 1_800_000_000

// No pid these tests invent is a `claude` process on this machine, so the real
// reader answers with nothing useful. Mocked, a test can say which pid is live.
vi.mock('./derive/processes.js', () => ({ listProcesses: vi.fn(async () => new Map()) }))

const execFileAsync = promisify(execFile)

/** A repository holding one progress file per name given. */
async function repoWithProgressFiles(names: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-board-repo-')))
  await execFileAsync('git', ['-C', root, 'init', '-q'])
  for (const name of names) {
    await writeFile(join(root, `${name}.progress.local.md`), `# ${name}\n`)
  }

  return root
}

function config(): Config {
  return {
    eventLogPath: '/unused/events.jsonl',
    metadataPath: '/unused/sessions.json',
    groupsPath: '/unused/groups.json',
    port: 4747,
    staleDays: 4,
    freshMinutes: 15,
    launchCommand: 'claude --resume {{id}} --append-system-prompt-file {{system}}',
    openFileCommand: 'code -- {{path}}',
    progressCommand: 'claude -n {{name}} --append-system-prompt-file {{system}} {{prompt}}',
    progressPrompt: 'Read {{progress}} and carry on.',
    subagentGrantPath: '/unused/subagent-grant.md',
    noProgressNote: 'Do not create a progress file.',
    newProgressNote: 'A progress file is waiting at {{progress}}.',
    transcriptRoots: [],
  }
}

async function storeWith(metadata: MetadataBySession): Promise<{
  store: ReturnType<typeof createMetadataStore>
  groups: ReturnType<typeof createGroupStore>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-snapshot-'))
  const path = join(dir, 'sessions.json')
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`)

  return {
    store: createMetadataStore({ path }),
    groups: createGroupStore({ path: join(dir, 'groups.json') }),
  }
}

/** The two halves of a `/clear`: one session ends, the next starts on the same process. */
function handover({
  from,
  to,
  ppid = 900,
  agoSeconds = 200,
}: {
  from: string
  to: string
  ppid?: number
  agoSeconds?: number
}): HookEvent[] {
  const at = NOW - agoSeconds

  return [
    { session_id: from, hook_event_name: 'Stop', t: at - 100, hook_ppid: ppid },
    { session_id: from, hook_event_name: 'SessionEnd', t: at, hook_ppid: ppid, reason: 'clear' },
    {
      session_id: to,
      hook_event_name: 'SessionStart',
      t: at + 1,
      hook_ppid: ppid,
      source: 'clear',
    },
    { session_id: to, hook_event_name: 'Stop', t: at + 2, hook_ppid: ppid },
  ]
}

function namesOnBoard(board: { groups: { rows: { name?: string | undefined }[] }[] }): string[] {
  return board.groups
    .flatMap(group => group.rows)
    .map(row => row.name ?? '(unnamed)')
    .sort()
}

it('carries a row forward when a cleared session had no name waiting on the other side', async () => {
  const { store, groups } = await storeWith({ before: { name: 'impact' } })

  const board = await buildSnapshot({
    events: handover({ from: 'before', to: 'after' }),
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(namesOnBoard(board)).toEqual(['impact'])
  expect(await store.read()).toEqual({ after: { name: 'impact' } })
})

it('leaves a session that was taken off the board out of the handover', async () => {
  const { store, groups } = await storeWith({
    before: { isDismissed: true },
    after: { name: 'code-gardener', group: 'Bug week' },
  })

  const board = await buildSnapshot({
    events: handover({ from: 'before', to: 'after' }),
    store,
    groups,
    config: config(),
    now: NOW,
  })

  // Carrying the marker across would take the successor off the board too.
  expect(namesOnBoard(board)).toEqual(['code-gardener'])
  expect(await store.read()).toEqual({
    before: { isDismissed: true },
    after: { name: 'code-gardener', group: 'Bug week' },
  })
})

it('keeps both rows when the two named sessions sit at either end of a chain', async () => {
  const { store, groups } = await storeWith({
    first: { name: 'impact', group: 'Bug week' },
    last: { name: 'bme-orders', group: 'BME' },
  })

  // Cleared twice, with an unnamed throwaway in the middle. Comparing only the
  // next link would see impact -> middle and middle -> bme-orders, find no pair
  // of names, and fold impact into bme-orders anyway.
  const board = await buildSnapshot({
    events: [
      ...handover({ from: 'first', to: 'middle', agoSeconds: 400 }),
      ...handover({ from: 'middle', to: 'last', agoSeconds: 200 }),
    ],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(namesOnBoard(board)).toEqual(['bme-orders', 'impact'])
})

it('keeps both rows when a cleared terminal took up work that was already named', async () => {
  const { store, groups } = await storeWith({
    before: { name: 'impact', group: 'Bug week' },
    after: { name: 'bme-orders', group: 'BME' },
  })

  const board = await buildSnapshot({
    events: handover({ from: 'before', to: 'after' }),
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(namesOnBoard(board)).toEqual(['bme-orders', 'impact'])
  // The older row keeps everything it had rather than being folded away.
  expect(await store.read()).toEqual({
    before: { name: 'impact', group: 'Bug week' },
    after: { name: 'bme-orders', group: 'BME' },
  })
})

it('does not let a relaunched session claim itself back once its row has moved on', async () => {
  const { store, groups } = await storeWith({
    old: { name: 'soc2', group: 'Bug week', relaunchedAt: NOW - 10 },
  })

  // Every session the board launches is given a name, so the id it leaves
  // behind keeps a `session_title` in the log forever and claims itself the
  // moment it has no row. The pairing that moved the row away lived on the row
  // that was deleted, so nothing was left to say the two ids are one session.
  const events: HookEvent[] = [
    { session_id: 'old', hook_event_name: 'SessionStart', session_title: 'soc2', t: NOW - 500 },
    { session_id: 'fresh', hook_event_name: 'SessionStart', session_title: 'soc2', t: NOW - 8 },
  ]

  await buildSnapshot({ events, store, groups, config: config(), now: NOW })
  const board = await buildSnapshot({ events, store, groups, config: config(), now: NOW })

  expect(namesOnBoard(board)).toEqual(['soc2'])
  expect(board.groups.map(group => group.name)).toEqual(['Bug week'])
})

it('moves a relaunched row onto the session the board started for it', async () => {
  const { store, groups } = await storeWith({
    old: {
      name: 'technical-interview-round',
      group: 'Interviewing',
      progressPath: '/repo/technical-interview-round.progress.local.md',
      relaunchedAt: NOW - 10,
    },
  })

  const board = await buildSnapshot({
    events: [
      {
        session_id: 'fresh',
        hook_event_name: 'SessionStart',
        session_title: 'technical-interview-round',
        t: NOW - 8,
      },
    ],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  // One row, not the old one stranded in Interviewing beside a new one in
  // Ungrouped carrying the same name.
  expect(namesOnBoard(board)).toEqual(['technical-interview-round'])
  expect(board.groups.map(group => group.name)).toEqual(['Interviewing'])
  expect(await store.read()).toEqual({
    fresh: {
      name: 'technical-interview-round',
      group: 'Interviewing',
      progressPath: '/repo/technical-interview-round.progress.local.md',
    },
    // Empty but for the pointer: the id the board launched keeps its name in
    // the log, and this is what stops it claiming a row of its own again.
    old: { supersededBy: 'fresh' },
  })
})

it('keeps the row when a resume walks back to the session a relaunch moved it off', async () => {
  const { store, groups } = await storeWith({
    old: { name: 'ssr-iframe-main', group: 'ssr iframe', relaunchedAt: NOW - 600 },
  })

  const untilTheResume: HookEvent[] = [
    {
      session_id: 'old',
      hook_event_name: 'SessionStart',
      session_title: 'ssr-iframe-main',
      t: NOW - 900,
    },
    {
      session_id: 'fresh',
      hook_event_name: 'SessionStart',
      session_title: 'ssr-iframe-main',
      t: NOW - 598,
    },
  ]

  // Pairs the click to `fresh` and writes the pointer the second snapshot has
  // to argue with.
  await buildSnapshot({ events: untilTheResume, store, groups, config: config(), now: NOW })

  const board = await buildSnapshot({
    // `/resume` in the tab the board opened, picking the session the relaunch
    // moved the row off. The pointer still says `old` handed its work to
    // `fresh`, so the two records close a loop, and reading the loop as a chain
    // makes both ends superseded: the row is drawn neither on the board nor in
    // the drawer, and there is no way left to reach the work.
    events: [
      ...untilTheResume,
      {
        session_id: 'fresh',
        hook_event_name: 'SessionEnd',
        reason: 'resume',
        hook_ppid: 900,
        t: NOW - 100,
      },
      {
        session_id: 'old',
        hook_event_name: 'SessionStart',
        source: 'resume',
        hook_ppid: 900,
        t: NOW - 99,
      },
      { session_id: 'old', hook_event_name: 'Stop', hook_ppid: 900, t: NOW - 50 },
    ],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(namesOnBoard(board)).toEqual(['ssr-iframe-main'])
  expect(board.groups.flatMap(group => group.rows).map(row => row.sessionId)).toEqual(['old'])
  expect(await store.read()).toEqual({ old: { name: 'ssr-iframe-main', group: 'ssr iframe' } })
})

it('erases the pointer of a row the resume walked back to', async () => {
  const { store, groups } = await storeWith({
    resumed: { name: 'ssr-iframe-main', supersededBy: 'relaunched' },
    // Nothing but the pointer, which is the whole of a row whose work has moved
    // on. Emptying it would leave a claimed row the board draws as unnamed.
    tombstone: { supersededBy: 'relaunched' },
  })

  const board = await buildSnapshot({
    // Both rows have been worked in since `relaunched` last fired, so neither
    // pointer describes a handover any more.
    events: [
      { session_id: 'relaunched', hook_event_name: 'SessionStart', t: NOW - 500 },
      { session_id: 'tombstone', hook_event_name: 'SessionStart', t: NOW - 200 },
      { session_id: 'resumed', hook_event_name: 'SessionStart', t: NOW - 100 },
    ],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(namesOnBoard(board)).toEqual(['ssr-iframe-main'])
  // A name a live row holds has to read as taken, or the board starts a second
  // session under it.
  expect(await store.read()).toEqual({ resumed: { name: 'ssr-iframe-main' } })
})

it('takes the finished row off the board when a live session holds the same name', async () => {
  const { store, groups } = await storeWith({
    finished: { name: 'ssr-iframe-main', group: 'ssr iframe' },
    live: { name: 'ssr-iframe-main' },
  })

  vi.mocked(listProcesses).mockResolvedValueOnce(
    new Map([[900, { pid: 900, startedAt: NOW - 1000, command: 'claude' }]]),
  )

  const board = await buildSnapshot({
    events: [
      { session_id: 'finished', hook_event_name: 'SessionStart', t: NOW - 800 },
      {
        session_id: 'finished',
        hook_event_name: 'SessionEnd',
        reason: 'prompt_input_exit',
        t: NOW - 700,
      },
      { session_id: 'live', hook_event_name: 'SessionStart', hook_ppid: 900, t: NOW - 600 },
      { session_id: 'live', hook_event_name: 'Stop', hook_ppid: 900, t: NOW - 60 },
    ],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(board.groups.flatMap(group => group.rows).map(row => row.sessionId)).toEqual(['live'])
  expect(board.unclaimed.map(row => row.sessionId)).toEqual(['finished'])
  // The group is still on the row, so editing it in the drawer puts the work
  // back where it was rather than leaving it to be filed again.
  expect((await store.read())['finished']).toEqual({
    name: 'ssr-iframe-main',
    group: 'ssr iframe',
    isDismissed: true,
  })
})

it('keeps both rows of one name while two sessions under it are running', async () => {
  const { store, groups } = await storeWith({
    first: { name: 'ssr-iframe-main' },
    second: { name: 'ssr-iframe-main' },
  })

  // Two terminals on the same work. Nothing says which row to keep, so the
  // board says so by leaving both.
  vi.mocked(listProcesses).mockResolvedValueOnce(
    new Map([
      [900, { pid: 900, startedAt: NOW - 1000, command: 'claude' }],
      [901, { pid: 901, startedAt: NOW - 1000, command: 'claude' }],
    ]),
  )

  const board = await buildSnapshot({
    events: [
      { session_id: 'first', hook_event_name: 'SessionStart', hook_ppid: 900, t: NOW - 600 },
      { session_id: 'second', hook_event_name: 'SessionStart', hook_ppid: 901, t: NOW - 500 },
    ],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(board.groups.flatMap(group => group.rows).map(row => row.sessionId)).toEqual([
    'first',
    'second',
  ])
})

it('drops a placeholder row once no session can pair with it any more', async () => {
  const { store, groups } = await storeWith({
    'pending-1111': { name: 'review-perf', group: 'Bug week', relaunchedAt: NOW - 600 },
  })

  const board = await buildSnapshot({ events: [], store, groups, config: config(), now: NOW })

  // The tab opened but no session ever started in it, so nothing will pair. The
  // row draws nothing without a `lastActive`, so left in the file it would hold
  // `review-perf` against the next attempt with no row on screen to delete.
  expect(namesOnBoard(board)).toEqual([])
  expect(await store.read()).toEqual({})
})

it('keeps a placeholder row while the session it started still has time to appear', async () => {
  const { store, groups } = await storeWith({
    'pending-1111': { name: 'review-perf', relaunchedAt: NOW - 30 },
  })

  await buildSnapshot({ events: [], store, groups, config: config(), now: NOW })

  // A session takes a second or two to fire its first hook, and a snapshot runs
  // in between. Reaping on that one would take the row away from the session on
  // its way to claim it.
  expect(await store.read()).toEqual({
    'pending-1111': { name: 'review-perf', relaunchedAt: NOW - 30 },
  })
})

it('links a progress file to a live row and leaves the rows that draw nothing alone', async () => {
  const root = await repoWithProgressFiles(['live-work', 'dismissed-work', 'superseded-work'])
  const { store, groups } = await storeWith({
    live: { name: 'live-work' },
    dropped: { name: 'dismissed-work', isDismissed: true },
    handed: { name: 'superseded-work', supersededBy: 'somewhere-else' },
  })
  const at = (sessionId: string): HookEvent => ({
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    t: NOW - 100,
    cwd: root,
  })

  await buildSnapshot({
    events: [at('live'), at('dropped'), at('handed')],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  // Neither of the other two can ever show a link: one is off the board and the
  // other is an empty pointer. Every row without a path costs a `git rev-parse`
  // on every snapshot, and snapshots run on every hook event, so on the real
  // board this was 19 of them and 0.5 seconds spent to link nothing.
  expect(await store.read()).toEqual({
    live: { name: 'live-work', progressPath: join(root, 'live-work.progress.local.md') },
    dropped: { name: 'dismissed-work', isDismissed: true },
    handed: { name: 'superseded-work', supersededBy: 'somewhere-else' },
  })
})

it('registers a group it meets on a row, so emptying that group cannot delete it', async () => {
  const { store, groups } = await storeWith({ a: { name: 'impact', group: 'Bug week' } })

  await buildSnapshot({
    events: [{ session_id: 'a', hook_event_name: 'Stop', t: NOW - 10 }],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(await groups.read()).toEqual(['Bug week'])
})

it('draws a group that was created before any session was put in it', async () => {
  const { store, groups } = await storeWith({ a: { name: 'impact', group: 'Bug week' } })
  await groups.add('Stash')

  const board = await buildSnapshot({
    events: [{ session_id: 'a', hook_event_name: 'Stop', t: NOW - 10 }],
    store,
    groups,
    config: config(),
    now: NOW,
  })

  expect(board.groups.map(group => group.name)).toEqual(['Bug week', 'Stash'])
})
