import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendOverride, type OverrideEntry, readOverrides } from './overrides.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tasks-overrides-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(fields: Partial<OverrideEntry> = {}): OverrideEntry {
  return {
    timestamp: new Date(2026, 7, 19, 10, 0).toISOString(),
    title: 'a task',
    list: 'todos',
    cap: 3,
    active_count: 3,
    ...fields,
  }
}

describe('readOverrides', () => {
  // The ordinary case for a long time yet: the file appears the first time you use --over-cap.
  it('reads no overrides when the file does not exist', () => {
    expect(readOverrides({ dir })).toEqual([])
  })

  it('reads back everything the writer appended', () => {
    appendOverride({ entry: entry({ title: 'first' }), dir })
    appendOverride({ entry: entry({ title: 'second', active_count: 4 }), dir })

    expect(readOverrides({ dir }).map(override => override.title)).toEqual(['first', 'second'])
    expect(readOverrides({ dir })[1]?.active_count).toBe(4)
  })

  // Every append ends in a newline, so the last line of the file is always empty.
  it('reads no entry from the trailing newline', () => {
    writeFileSync(join(dir, 'overrides.jsonl'), `${JSON.stringify(entry())}\n`)

    expect(readOverrides({ dir })).toHaveLength(1)
  })

  // Skipping the line would make the count quietly low, and a suggestion that never fires is a
  // failure nobody would ever notice.
  it('refuses a line that is not JSON, naming the file', () => {
    writeFileSync(join(dir, 'overrides.jsonl'), 'not json\n')

    expect(() => readOverrides({ dir })).toThrow(/overrides\.jsonl/)
  })

  it('refuses a line missing a field it needs', () => {
    writeFileSync(join(dir, 'overrides.jsonl'), `${JSON.stringify({ title: 'a task' })}\n`)

    expect(() => readOverrides({ dir })).toThrow(/overrides\.jsonl/)
  })
})
