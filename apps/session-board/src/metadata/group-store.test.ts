import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createGroupStore } from './group-store.js'

async function storeInTempDir(): Promise<{
  path: string
  store: ReturnType<typeof createGroupStore>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-groups-'))
  const path = join(dir, 'nested', 'groups.json')

  return { path, store: createGroupStore({ path }) }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)

    return true
  } catch {
    return false
  }
}

it('reads no groups before any have been created', async () => {
  const { store } = await storeInTempDir()

  expect(await store.read()).toEqual([])
})

it('creates a group that has no sessions in it yet', async () => {
  const { store } = await storeInTempDir()

  expect(await store.add('Bug week')).toBe(true)
  expect(await store.read()).toEqual(['Bug week'])
})

it('refuses a name that is already a group, rather than listing it twice', async () => {
  const { store } = await storeInTempDir()
  await store.add('Bug week')

  expect(await store.add('Bug week')).toBe(false)
  expect(await store.read()).toEqual(['Bug week'])
})

it('renames a group in place', async () => {
  const { store } = await storeInTempDir()
  await store.add('Bug week')
  await store.add('Stash')

  await store.rename({ from: 'Bug week', to: 'Bug month' })

  expect(await store.read()).toEqual(['Bug month', 'Stash'])
})

it('merges into the group it is renamed onto, rather than listing that name twice', async () => {
  const { store } = await storeInTempDir()
  await store.add('Bug week')
  await store.add('Stash')

  await store.rename({ from: 'Stash', to: 'Bug week' })

  expect(await store.read()).toEqual(['Bug week'])
})

it('drops a group that is deleted', async () => {
  const { store } = await storeInTempDir()
  await store.add('Bug week')
  await store.add('Stash')

  await store.remove('Bug week')

  expect(await store.read()).toEqual(['Stash'])
})

it('registers a name the board has never seen, so emptying it cannot lose it', async () => {
  const { store } = await storeInTempDir()

  expect(await store.register(['Bug week', 'Stash'])).toEqual(['Bug week', 'Stash'])
  expect(await store.read()).toEqual(['Bug week', 'Stash'])
})

it('writes nothing when every name is already registered', async () => {
  const { path, store } = await storeInTempDir()

  // Every write wakes the watcher that asks for the next snapshot, and a
  // snapshot is what calls this, so a write per snapshot would never settle.
  expect(await store.register([])).toEqual([])
  expect(await exists(path)).toBe(false)
})
