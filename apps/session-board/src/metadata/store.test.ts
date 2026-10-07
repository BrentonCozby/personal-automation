import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMetadataStore } from './store.js'
import type { MetadataBySession } from './types.js'

async function storeInTempDir(): Promise<{
  path: string
  store: ReturnType<typeof createMetadataStore>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-'))
  const path = join(dir, 'nested', 'sessions.json')

  return { path, store: createMetadataStore({ path }) }
}

it('reads an empty board before anything has been claimed', async () => {
  const { store } = await storeInTempDir()

  expect(await store.read()).toEqual({})
})

it('claims a session by writing its first field', async () => {
  const { store } = await storeInTempDir()

  await store.patch({ sessionId: 'abc', changes: { name: 'impact' } })

  expect(await store.read()).toEqual({ abc: { name: 'impact' } })
})

it('merges a change into an existing row without disturbing the others', async () => {
  const { store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact', group: 'Bug week' } })
  await store.patch({ sessionId: 'xyz', changes: { name: 'stats' } })

  await store.patch({ sessionId: 'abc', changes: { parkedReason: 'waiting on backfill' } })

  expect(await store.read()).toEqual({
    abc: { name: 'impact', group: 'Bug week', parkedReason: 'waiting on backfill' },
    xyz: { name: 'stats' },
  })
})

it('clears a field when the change sets it to undefined', async () => {
  const { store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact', parkedReason: 'waiting' } })

  const merged = await store.patch({ sessionId: 'abc', changes: { parkedReason: undefined } })

  expect(merged).toEqual({ name: 'impact' })
  expect(await store.read()).toEqual({ abc: { name: 'impact' } })
})

it('leaves no undefined keys in the written file', async () => {
  const { path, store } = await storeInTempDir()

  await store.patch({ sessionId: 'abc', changes: { name: 'impact', group: undefined } })

  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ abc: { name: 'impact' } })
})

it('unclaims a session by removing its row', async () => {
  const { store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact' } })
  await store.patch({ sessionId: 'xyz', changes: { name: 'stats' } })

  await store.remove('abc')

  expect(await store.read()).toEqual({ xyz: { name: 'stats' } })
})

it('ignores removing a session that was never claimed', async () => {
  const { store } = await storeInTempDir()

  await expect(store.remove('never-existed')).resolves.toBeUndefined()
})

it('picks up an edit made to the file by hand', async () => {
  const { path, store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact' } })

  await writeFile(path, JSON.stringify({ abc: { name: 'renamed by hand' } }), 'utf8')

  expect(await store.read()).toEqual({ abc: { name: 'renamed by hand' } })
})

it('refuses to read a damaged file rather than reporting an empty board', async () => {
  // Reporting empty would look like a working board with nothing on it, and the
  // next edit would write that emptiness over the real annotations.
  const { path, store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact' } })
  await writeFile(path, '{ not json', 'utf8')

  await expect(store.read()).rejects.toThrow()
})

it('refuses a file whose shape does not match', async () => {
  const { path, store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact' } })
  await writeFile(path, JSON.stringify({ abc: { name: 42 } }), 'utf8')

  await expect(store.read()).rejects.toThrow()
})

it('keeps the name when a row is taken off the board, and drops the rest', async () => {
  const { store } = await storeInTempDir()
  await store.patch({
    sessionId: 'abc',
    changes: { name: 'impact', group: 'home', parkedReason: 'review', progressPath: '/a.md' },
  })

  await store.dismiss('abc')

  expect(await store.read()).toEqual({ abc: { name: 'impact', isDismissed: true } })
})

it('takes an unnamed row off the board with the marker alone', async () => {
  const { store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { group: 'home' } })

  await store.dismiss('abc')

  expect(await store.read()).toEqual({ abc: { isDismissed: true } })
})

it('writes several rows in one go, leaving the rest of each row alone', async () => {
  const { store } = await storeInTempDir()
  await store.patch({ sessionId: 'abc', changes: { name: 'impact' } })

  await store.patchMany([
    { sessionId: 'abc', changes: { order: 1 } },
    { sessionId: 'xyz', changes: { order: 0 } },
  ])

  expect(await store.read()).toEqual({ abc: { name: 'impact', order: 1 }, xyz: { order: 0 } })
})

async function groupOf(ids: string[]): Promise<ReturnType<typeof createMetadataStore>> {
  const { store } = await storeInTempDir()
  await store.patchMany(
    ids.map((sessionId, order) => ({ sessionId, changes: { group: 'home', order } })),
  )

  return store
}

function orderIn(metadata: MetadataBySession): string[] {
  return Object.entries(metadata)
    .filter(([, entry]) => entry.group === 'home')
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
    .map(([id]) => id)
}

it.each([
  { move: 'c', before: 'a', expected: ['c', 'a', 'b'] },
  { move: 'a', before: 'c', expected: ['b', 'a', 'c'] },
  { move: 'a', before: undefined, expected: ['b', 'c', 'a'] },
  { move: 'b', before: 'gone', expected: ['a', 'c', 'b'] },
])('moves $move above $before inside its group', async ({ move, before, expected }) => {
  const store = await groupOf(['a', 'b', 'c'])

  await store.place({ sessionId: move, changes: {}, before })

  expect(orderIn(await store.read())).toEqual(expected)
})

it('moves a row into another group at the spot it was dropped, claiming it if need be', async () => {
  const store = await groupOf(['a', 'b'])

  const placed = await store.place({ sessionId: 'new', changes: { group: 'home' }, before: 'b' })

  expect(placed).toEqual({ group: 'home', order: 1 })
  expect(orderIn(await store.read())).toEqual(['a', 'new', 'b'])
})

it('renumbers the group a row left behind only when it is placed again', async () => {
  const store = await groupOf(['a', 'b', 'c'])

  await store.place({ sessionId: 'b', changes: { group: 'away' }, before: undefined })

  expect(await store.read()).toMatchObject({
    a: { order: 0 },
    b: { group: 'away', order: 0 },
    c: { order: 2 },
  })
})

it('leaves dismissed rows out of the numbering', async () => {
  const store = await groupOf(['a', 'b'])
  await store.patch({ sessionId: 'a', changes: { isDismissed: true } })

  await store.place({ sessionId: 'c', changes: { group: 'home' }, before: undefined })

  expect(await store.read()).toMatchObject({ b: { order: 0 }, c: { order: 1 } })
})
