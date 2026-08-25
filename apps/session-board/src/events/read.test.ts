import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createEventLogReader } from './read.js'

async function logPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'session-board-')), 'events.jsonl')
}

function line(sessionId: string, t: number): string {
  return `${JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, t })}\n`
}

it('reads an empty result before the hook has written anything', async () => {
  const reader = createEventLogReader({ path: await logPath() })

  expect(await reader.readAll()).toEqual({ events: [], skippedLineCount: 0 })
})

it('reads everything written so far', async () => {
  const path = await logPath()
  await writeFile(path, line('a', 1) + line('b', 2), 'utf8')

  const { events } = await createEventLogReader({ path }).readAll()

  expect(events.map(event => event.session_id)).toEqual(['a', 'b'])
})

it('returns only what was appended since the last read', async () => {
  const path = await logPath()
  await writeFile(path, line('a', 1), 'utf8')
  const reader = createEventLogReader({ path })
  await reader.readAll()

  await appendFile(path, line('b', 2), 'utf8')

  expect((await reader.readAppended()).events.map(event => event.session_id)).toEqual(['b'])
})

it('returns nothing when nothing was appended', async () => {
  const path = await logPath()
  await writeFile(path, line('a', 1), 'utf8')
  const reader = createEventLogReader({ path })
  await reader.readAll()

  expect(await reader.readAppended()).toEqual({ events: [], skippedLineCount: 0 })
})

it('holds back a line that has no newline yet and emits it once it lands', async () => {
  // A hook caught mid-write leaves a fragment. Parsing it would report a real
  // event as a damaged line and then lose it.
  const path = await logPath()
  const whole = line('a', 1)
  await writeFile(path, whole.slice(0, 20), 'utf8')

  const reader = createEventLogReader({ path })
  const first = await reader.readAll()

  expect(first).toEqual({ events: [], skippedLineCount: 0 })

  await appendFile(path, whole.slice(20), 'utf8')

  expect((await reader.readAppended()).events.map(event => event.session_id)).toEqual(['a'])
})

it('starts over when the file is replaced by a shorter one', async () => {
  const path = await logPath()
  await writeFile(path, line('a', 1) + line('b', 2) + line('c', 3), 'utf8')
  const reader = createEventLogReader({ path })
  await reader.readAll()

  await writeFile(path, line('fresh', 9), 'utf8')

  expect((await reader.readAppended()).events.map(event => event.session_id)).toEqual(['fresh'])
})

it('rereads from the beginning on readAll', async () => {
  const path = await logPath()
  await writeFile(path, line('a', 1), 'utf8')
  const reader = createEventLogReader({ path })
  await reader.readAll()

  expect((await reader.readAll()).events.map(event => event.session_id)).toEqual(['a'])
})
