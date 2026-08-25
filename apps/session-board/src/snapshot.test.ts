import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Config } from './config.js'
import type { HookEvent } from './events/types.js'
import { createGroupStore } from './metadata/group-store.js'
import { createMetadataStore } from './metadata/store.js'
import type { MetadataBySession } from './metadata/types.js'
import { buildSnapshot } from './snapshot.js'

const NOW = 1_800_000_000

function config(): Config {
  return {
    eventLogPath: '/unused/events.jsonl',
    metadataPath: '/unused/sessions.json',
    groupsPath: '/unused/groups.json',
    port: 4747,
    staleDays: 4,
    freshMinutes: 15,
    launchCommand: 'claude --resume {{id}}',
    openFileCommand: 'code -- {{path}}',
    progressCommand: 'claude -n {{name}} {{prompt}}',
    progressPrompt: 'Read {{progress}} and carry on.',
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
