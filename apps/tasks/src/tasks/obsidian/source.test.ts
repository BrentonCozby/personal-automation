import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createObsidianTaskSource } from './source.js'

// Line-level parsing is covered by scan.test.ts. These cover what the source adds on top: which
// files it reads, and how a scanned line becomes a Task.

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'obsidian-source-'))
})

afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

it('reads todos.md at the vault root by default', async () => {
  await writeFile(join(vault, 'todos.md'), '# Todos\n- [ ] buy milk ➕ 2026-06-01\n')
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: [] }).list()

  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.title).toBe('buy milk')
  expect(tasks[0]?.list).toBe('todos')
  expect(tasks[0]?.created?.getDate()).toBe(1)
  expect(tasks[0]?.lastModified).toBeNull()
})

it('does not sweep in checkboxes from other notes when reading the default inbox', async () => {
  await writeFile(join(vault, 'todos.md'), '- [ ] real todo\n')
  await mkdir(join(vault, 'Notes'))
  await writeFile(join(vault, 'Notes', 'meeting.md'), '- [ ] an incidental checkbox\n')
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: [] }).list()

  expect(tasks.map(task => task.title)).toEqual(['real todo'])
})

it('walks a configured folder for its markdown files', async () => {
  await mkdir(join(vault, 'Projects'))
  await writeFile(join(vault, 'Projects', 'work.md'), '- [ ] ship it\n')
  await writeFile(join(vault, 'todos.md'), '- [ ] inbox item\n')
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: ['Projects'] }).list()

  expect(tasks.map(task => task.title)).toEqual(['ship it'])
  expect(tasks[0]?.list).toBe('work')
})

it('skips dot-prefixed folders inside a configured folder', async () => {
  await mkdir(join(vault, 'Projects', '.trash'), { recursive: true })
  await writeFile(join(vault, 'Projects', 'work.md'), '- [ ] ship it\n')
  await writeFile(join(vault, 'Projects', '.trash', 'old.md'), '- [ ] deleted todo\n')
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: ['Projects'] }).list()

  expect(tasks.map(task => task.title)).toEqual(['ship it'])
})

it('keeps only open tasks, and only ones with a title', async () => {
  await writeFile(
    join(vault, 'todos.md'),
    ['- [ ] open task', '- [x] done task', '- [ ] 📅 2026-02-15'].join('\n'),
  )
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: [] }).list()

  expect(tasks.map(task => task.title)).toEqual(['open task'])
})

it('ids a task by file and line, counting the lines that are not tasks', async () => {
  await mkdir(join(vault, 'work'))
  await writeFile(
    join(vault, 'work', 'todos.md'),
    ['# Todos', '', '- [ ] first', 'some prose', '- [ ] second'].join('\n'),
  )
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: ['work'] }).list()

  expect(tasks.map(task => task.id)).toEqual(['work/todos.md:3', 'work/todos.md:5'])
})

it('carries the line and its notes as raw, for the touch clock to hash', async () => {
  await writeFile(join(vault, 'todos.md'), ['- [ ] plan trip', '  - book hotel'].join('\n'))
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: [] }).list()

  expect(tasks[0]?.notes).toBe('book hotel')
  expect(tasks[0]?.raw).toBe('- [ ] plan trip\nbook hotel')
})

it('throws a clear AppError when the vault path does not exist', async () => {
  const source = createObsidianTaskSource({ vaultPath: join(vault, 'missing'), lists: [] })

  await expect(source.list()).rejects.toThrow(AppError)
  await expect(source.list()).rejects.toThrow(/vault not found/)
})

it('throws a clear AppError when a configured task path is missing', async () => {
  const source = createObsidianTaskSource({ vaultPath: vault, lists: ['nope.md'] })

  await expect(source.list()).rejects.toThrow(/not found in the vault/)
})
