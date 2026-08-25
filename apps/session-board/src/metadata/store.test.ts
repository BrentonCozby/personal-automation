import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMetadataStore } from './store.js'

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
