import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeChangedLines } from './write.js'

let dir: string
let absPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'obsidian-write-'))
  absPath = join(dir, 'todos.md')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('replaces only the named lines and leaves the rest of the file alone', async () => {
  await writeFile(absPath, ['# Todos', '- [ ] one', '- [ ] two', '', 'some prose'].join('\n'))
  const isWritten = await writeChangedLines({
    absPath,
    changes: [{ line: 3, before: '- [ ] two', after: '- [ ] two #active' }],
  })

  expect(isWritten).toBe(true)
  expect(await readFile(absPath, 'utf8')).toBe(
    ['# Todos', '- [ ] one', '- [ ] two #active', '', 'some prose'].join('\n'),
  )
})

// Obsidian Sync and the Git plugin are both live on this vault, so a write can land underneath a
// concurrent edit. Half-writing a file is worse than not writing it.
it('writes nothing when any one line no longer matches what was read', async () => {
  await writeFile(absPath, ['- [ ] one', '- [ ] two'].join('\n'))
  const isWritten = await writeChangedLines({
    absPath,
    changes: [
      { line: 1, before: '- [ ] one', after: '- [ ] one #active' },
      { line: 2, before: '- [ ] stale text', after: '- [ ] two #active' },
    ],
  })

  expect(isWritten).toBe(false)
  expect(await readFile(absPath, 'utf8')).toBe(['- [ ] one', '- [ ] two'].join('\n'))
})

// The write goes through a temporary file so a killed run cannot truncate the vault. Leaving that
// file behind would put a second copy of the task list in the folder Obsidian reads.
it('leaves no temporary file in the folder it wrote to', async () => {
  await writeFile(absPath, '- [ ] one')
  await writeChangedLines({
    absPath,
    changes: [{ line: 1, before: '- [ ] one', after: '- [ ] one #active' }],
  })

  expect(await readdir(dir)).toEqual(['todos.md'])
})

it('keeps CRLF line endings', async () => {
  await writeFile(absPath, '- [ ] one\r\n- [ ] two')
  await writeChangedLines({
    absPath,
    changes: [{ line: 1, before: '- [ ] one', after: '- [ ] one #active' }],
  })

  expect(await readFile(absPath, 'utf8')).toBe('- [ ] one #active\r\n- [ ] two')
})
