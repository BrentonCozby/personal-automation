import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Task } from '../types.js'
import { createObsidianTaskSource, parseTodoMarkdown } from './source.js'

function parse(content: string): Task[] {
  return parseTodoMarkdown({ content, relativePath: 'todos.md', list: 'todos' })
}

it('parses an open task and maps the created/due markers', () => {
  const tasks = parse('- [ ] book india flights ➕ 2025-05-20 📅 2026-06-24')

  expect(tasks).toHaveLength(1)
  const task = tasks[0]
  expect(task?.title).toBe('book india flights')
  expect(task?.list).toBe('todos')
  expect(task?.id).toBe('todos.md:1')
  expect(task?.notes).toBeNull()
  expect(task?.lastModified).toBeNull()
})

it('parses dates as LOCAL midnight, not UTC (no off-by-one on the staleness clock)', () => {
  const [task] = parse('- [ ] file taxes ➕ 2026-01-01')

  // new Date('2026-01-01') would be UTC midnight — the previous day in any negative-offset zone.
  expect(task?.created?.getFullYear()).toBe(2026)
  expect(task?.created?.getMonth()).toBe(0)
  expect(task?.created?.getDate()).toBe(1)
  expect(task?.created?.getHours()).toBe(0)
})

it('treats only `[ ]` as open — skips done, cancelled, in-progress, and other statuses', () => {
  const tasks = parse(
    [
      '- [ ] open task',
      '- [x] done task',
      '- [X] done upper',
      '- [-] cancelled task',
      '- [/] in progress task',
      '- [>] forwarded task',
    ].join('\n'),
  )

  expect(tasks.map(t => t.title)).toEqual(['open task'])
})

it('drops recurring (🔁) tasks — their own reminder is the channel', () => {
  const tasks = parse(
    ['- [ ] book flights', '- [ ] water the plants 🔁 every week ➕ 2026-06-01'].join('\n'),
  )

  expect(tasks.map(t => t.title)).toEqual(['book flights'])
})

it('supports -, *, and + bullet markers and leading indentation (subtasks)', () => {
  const tasks = parse(['- [ ] dash', '* [ ] star', '+ [ ] plus', '  - [ ] indented'].join('\n'))

  expect(tasks.map(t => t.title)).toEqual(['dash', 'star', 'plus', 'indented'])
})

it('leaves created/due null when their markers are absent', () => {
  const [task] = parse('- [ ] just a plain todo')

  expect(task?.created).toBeNull()
  expect(task?.due).toBeNull()
})

it('strips Tasks metadata from the title but keeps #tags', () => {
  const [task] = parse('- [ ] file taxes 🔼 ➕ 2026-01-01 📅 2026-02-15 🛫 2026-01-05 #finance')

  expect(task?.title).toBe('file taxes #finance')
  expect(task?.created?.getDate()).toBe(1)
  expect(task?.due?.getMonth()).toBe(1)
})

it('strips id / dependsOn / onCompletion markers from the title', () => {
  const [task] = parse('- [ ] ship release 🆔 abc123 ⛔ def456 🏁 delete')

  expect(task?.title).toBe('ship release')
})

it('ids are relativePath:lineNumber, counting non-task lines', () => {
  const tasks = parseTodoMarkdown({
    content: ['# Todos', '', '- [ ] first', 'some prose', '- [ ] second'].join('\n'),
    relativePath: 'work/todos.md',
    list: 'todos',
  })

  expect(tasks.map(t => t.id)).toEqual(['work/todos.md:3', 'work/todos.md:5'])
})

it('ignores headers, prose, and blank lines', () => {
  const tasks = parse(['# Heading', '', 'a paragraph of notes', '> a quote', '---'].join('\n'))

  expect(tasks).toEqual([])
})

it('returns an empty array for empty content', () => {
  expect(parse('')).toEqual([])
})

it('handles CRLF line endings', () => {
  const tasks = parse('- [ ] one\r\n- [ ] two')

  expect(tasks.map(t => t.title)).toEqual(['one', 'two'])
})

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
})

it('does not sweep in checkboxes from other notes when reading the default inbox', async () => {
  await writeFile(join(vault, 'todos.md'), '- [ ] real todo\n')
  await mkdir(join(vault, 'Notes'))
  await writeFile(join(vault, 'Notes', 'meeting.md'), '- [ ] an incidental checkbox\n')
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: [] }).list()

  expect(tasks.map(t => t.title)).toEqual(['real todo'])
})

it('walks a configured folder for its markdown files', async () => {
  await mkdir(join(vault, 'Projects'))
  await writeFile(join(vault, 'Projects', 'work.md'), '- [ ] ship it\n')
  await writeFile(join(vault, 'todos.md'), '- [ ] inbox item\n')
  const tasks = await createObsidianTaskSource({ vaultPath: vault, lists: ['Projects'] }).list()

  expect(tasks.map(t => t.title)).toEqual(['ship it'])
  expect(tasks[0]?.list).toBe('work')
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
