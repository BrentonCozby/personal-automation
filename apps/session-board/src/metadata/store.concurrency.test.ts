import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMetadataStore } from './store.js'

async function storeInTempDir(): Promise<{
  path: string
  store: ReturnType<typeof createMetadataStore>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-'))
  const path = join(dir, 'sessions.json')

  return { path, store: createMetadataStore({ path }) }
}

it('keeps every edit when many are made at once', async () => {
  // Overlapping read-modify-write cycles used to lose all but the last edit.
  const { store } = await storeInTempDir()

  await Promise.all(
    Array.from({ length: 25 }, (_unused, index) =>
      store.patch({ sessionId: `session-${index}`, changes: { name: `name-${index}` } }),
    ),
  )

  expect(Object.keys(await store.read())).toHaveLength(25)
})

it('leaves the file parseable after concurrent writes of differing length', async () => {
  // Two writes sharing one temporary file produced a complete object followed
  // by the tail of a longer one, which no JSON parser will accept.
  const { path, store } = await storeInTempDir()

  await Promise.all([
    store.patch({ sessionId: 'long', changes: { name: 'x'.repeat(500), group: 'y'.repeat(500) } }),
    store.patch({ sessionId: 'short', changes: { name: 'a' } }),
    store.patch({ sessionId: 'long', changes: { name: 'b' } }),
    store.remove('short'),
    store.patch({ sessionId: 'third', changes: { name: 'c' } }),
  ])

  const written = await readFile(path, 'utf8')

  expect(() => JSON.parse(written)).not.toThrow()
})

it('applies interleaved edits to one session in order', async () => {
  const { store } = await storeInTempDir()

  await Promise.all([
    store.patch({ sessionId: 'a', changes: { name: 'first' } }),
    store.patch({ sessionId: 'a', changes: { group: 'Bug week' } }),
    store.patch({ sessionId: 'a', changes: { parkedReason: 'waiting' } }),
  ])

  expect(await store.read()).toEqual({
    a: { name: 'first', group: 'Bug week', parkedReason: 'waiting' },
  })
})

it('lets a later write succeed after an earlier one fails', async () => {
  const { store } = await storeInTempDir()
  const broken = createMetadataStore({ path: '/nope/not/a/directory/sessions.json' })

  await expect(broken.patch({ sessionId: 'a', changes: { name: 'x' } })).rejects.toThrow()
  await store.patch({ sessionId: 'b', changes: { name: 'ok' } })

  expect(await store.read()).toEqual({ b: { name: 'ok' } })
})
