import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkRevertible } from './git-guard.js'

const run = promisify(execFile)

let vaultPath: string

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), 'tasks-git-'))
})

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true })
})

async function initRepo(): Promise<void> {
  await run('git', ['init', '-q'], { cwd: vaultPath })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: vaultPath })
  await run('git', ['config', 'user.name', 'Test'], { cwd: vaultPath })
}

async function commitAll(): Promise<void> {
  await run('git', ['add', '-A'], { cwd: vaultPath })
  await run('git', ['commit', '-q', '-m', 'seed'], { cwd: vaultPath })
}

test('reports a directory that is not a git repository', async () => {
  await writeFile(join(vaultPath, 'todos.md'), '- [ ] one')

  const check = await checkRevertible({ vaultPath, paths: ['todos.md'] })

  expect(check).toEqual({ kind: 'not_a_repo' })
})

test('passes when every path is tracked and unmodified', async () => {
  await initRepo()
  await writeFile(join(vaultPath, 'todos.md'), '- [ ] one')
  await commitAll()

  const check = await checkRevertible({ vaultPath, paths: ['todos.md'] })

  expect(check).toEqual({ kind: 'ok' })
})

test('blocks on a path git does not track', async () => {
  await initRepo()
  await writeFile(join(vaultPath, 'tracked.md'), '- [ ] one')
  await commitAll()
  await writeFile(join(vaultPath, 'new.md'), '- [ ] two')

  const check = await checkRevertible({ vaultPath, paths: ['tracked.md', 'new.md'] })

  expect(check).toEqual({ kind: 'blocked', untracked: ['new.md'], modified: [] })
})

test('blocks on a tracked path with uncommitted edits', async () => {
  await initRepo()
  await writeFile(join(vaultPath, 'todos.md'), '- [ ] one')
  await commitAll()
  await writeFile(join(vaultPath, 'todos.md'), '- [ ] one edited')

  const check = await checkRevertible({ vaultPath, paths: ['todos.md'] })

  expect(check).toEqual({ kind: 'blocked', untracked: [], modified: ['todos.md'] })
})

// The real vault always has uncommitted plugin churn under .obsidian, so a whole-tree cleanliness
// check would never pass. Only the files the pass would rewrite matter.
test('ignores changes to files the pass will not touch', async () => {
  await initRepo()
  await writeFile(join(vaultPath, 'todos.md'), '- [ ] one')
  await writeFile(join(vaultPath, 'plugin.json'), '{}')
  await commitAll()
  await writeFile(join(vaultPath, 'plugin.json'), '{"changed":true}')

  const check = await checkRevertible({ vaultPath, paths: ['todos.md'] })

  expect(check).toEqual({ kind: 'ok' })
})
