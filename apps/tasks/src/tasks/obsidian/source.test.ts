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

it('keeps recurring tasks, stripping the 🔁 rule from the title', () => {
  const tasks = parse(
    ['- [ ] book flights', '- [ ] water the plants 🔁 every week ➕ 2026-06-01'].join('\n'),
  )

  expect(tasks.map(t => t.title)).toEqual(['book flights', 'water the plants'])
  expect(tasks[1]?.created?.getDate()).toBe(1)
})

it('strips a recurrence rule sitting between the title and the dates', () => {
  const [task] = parse('- [ ] call mom 🔁 every week on Sunday ➕ 2026-06-04 📅 2026-06-14')

  expect(task?.title).toBe('call mom')
  expect(task?.created?.getDate()).toBe(4)
  expect(task?.due?.getDate()).toBe(14)
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

// A state tag is bookkeeping, not part of what the task says. Leaving it in would put "#someday"
// in the digest email and in the text the model reads.
it('strips the state tag from the title', () => {
  const [task] = parse('- [ ] heath ceramics second hand #someday ➕ 2025-05-23')

  expect(task?.title).toBe('heath ceramics second hand')
})

it('keeps an unrelated tag while stripping the state tag', () => {
  const [task] = parse('- [ ] file taxes #finance #active')

  expect(task?.title).toBe('file taxes #finance')
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

it('captures an indented sub-bullet as the task notes', () => {
  const [task] = parse(
    ['- [ ] secure furniture ➕ 2025-12-08', '    - anchors are in the cabinet'].join('\n'),
  )

  expect(task?.notes).toBe('anchors are in the cabinet')
})

it('captures multi-line notes, stripping bullets and indentation', () => {
  const [task] = parse(['- [ ] plan trip', '  - book hotel', '  confirm dates'].join('\n'))

  expect(task?.notes).toBe('book hotel\nconfirm dates')
})

it('treats an indented checkbox as its own task, not the parent notes', () => {
  const tasks = parse(['- [ ] parent', '    - [ ] child'].join('\n'))

  expect(tasks.map(t => t.title)).toEqual(['parent', 'child'])
  expect(tasks[0]?.notes).toBeNull()
})

it('does not pull a following sibling task into notes', () => {
  const [first] = parse(['- [ ] a', '- [ ] b'].join('\n'))

  expect(first?.notes).toBeNull()
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
