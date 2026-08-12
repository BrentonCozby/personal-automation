import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { findMarkdownFiles, isScannablePath } from './vault.js'

test('scans a Markdown file', () => {
  expect(isScannablePath('Todos/todos.md')).toBe(true)
})

test('skips a file that is not Markdown', () => {
  expect(isScannablePath('Projects/photos/diagram.excalidraw')).toBe(false)
})

// .trash holds Obsidian's deleted copies, which would resurrect stale tasks into the plan.
test('skips anything under the trash folder', () => {
  expect(isScannablePath('.trash/photo-app 1.md')).toBe(false)
})

test('skips anything under the Obsidian config folder', () => {
  expect(isScannablePath('.obsidian/plugins/obsidian-tasks-plugin/README.md')).toBe(false)
})

test('skips anything under the git folder', () => {
  expect(isScannablePath('.git/COMMIT_EDITMSG.md')).toBe(false)
})

test('scans a file whose name contains a dot', () => {
  expect(isScannablePath('Projects/technical-interview-round.plan.md')).toBe(true)
})

let vaultPath: string

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), 'tasks-vault-'))
})

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true })
})

test('finds Markdown files nested at any depth', async () => {
  await mkdir(join(vaultPath, 'Projects', 'photos'), { recursive: true })
  await writeFile(join(vaultPath, 'todos.md'), '')
  await writeFile(join(vaultPath, 'Projects', 'photos', 'app.md'), '')

  const found = await findMarkdownFiles(vaultPath)

  expect(found.sort()).toEqual(['Projects/photos/app.md', 'todos.md'])
})

test('leaves excluded folders out of the walk', async () => {
  await mkdir(join(vaultPath, '.trash'), { recursive: true })
  await writeFile(join(vaultPath, '.trash', 'old.md'), '')
  await writeFile(join(vaultPath, 'todos.md'), '')

  const found = await findMarkdownFiles(vaultPath)

  expect(found).toEqual(['todos.md'])
})
