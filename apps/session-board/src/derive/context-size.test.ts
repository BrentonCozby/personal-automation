import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createContextReader, type LastTurn } from './context-size.js'
import type { Transcript } from './transcripts.js'

function turn({
  input,
  cacheRead = 0,
  cacheWrite = 0,
  isSidechain,
  model,
  timestamp,
}: {
  input: number
  cacheRead?: number
  cacheWrite?: number
  isSidechain?: boolean
  model?: string
  timestamp?: string | undefined
}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain,
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: 900,
      },
    },
  })
}

function prompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } })
}

async function transcriptOf(lines: string[]): Promise<Transcript> {
  const path = join(await mkdtemp(join(tmpdir(), 'session-board-context-')), 'abc.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`)

  return describe(path)
}

async function describe(path: string): Promise<Transcript> {
  const info = await stat(path)

  return { path, writtenAt: 0, size: info.size, modifiedMs: info.mtimeMs }
}

async function sizeOf(transcript: Transcript): Promise<number | undefined> {
  return (await lastTurnOf(transcript))?.tokens
}

async function lastTurnOf(transcript: Transcript): Promise<LastTurn | undefined> {
  const turns = await createContextReader().read({ transcripts: new Map([['abc', transcript]]) })

  return turns.get('abc')
}

it("counts the last turn's input, cache reads and cache writes", async () => {
  const transcript = await transcriptOf([
    turn({ input: 1, cacheRead: 50_000 }),
    prompt('and then'),
    turn({ input: 3, cacheRead: 180_000, cacheWrite: 2000 }),
    prompt('still going'),
  ])

  expect(await sizeOf(transcript)).toBe(182_003)
})

it.each([
  ['2026-10-07T18:35:46.005Z', 1_791_398_146],
  [undefined, undefined],
  ['not a date', undefined],
])('dates the last turn written at %s to unix second %s', async (timestamp, at) => {
  const transcript = await transcriptOf([
    turn({ input: 1, cacheRead: 5000, timestamp: '2026-10-07T17:00:00.000Z' }),
    turn({ input: 1, cacheRead: 6000, timestamp }),
  ])

  expect(await lastTurnOf(transcript)).toEqual({ tokens: 6001, at })
})

it.each([
  ['a subagent turn', { isSidechain: true }],
  ['an API error', { model: '<synthetic>' }],
])('passes over %s written after the last real turn', async (_label, extra) => {
  const transcript = await transcriptOf([
    turn({ input: 2, cacheRead: 90_000 }),
    turn({ input: 0, cacheRead: 7000, ...extra }),
  ])

  expect(await sizeOf(transcript)).toBe(90_002)
})

it('finds a turn written far further back than one read reaches', async () => {
  // About 3MB of tool output after the turn, so the search crosses many reads.
  const output = prompt('x'.repeat(100_000))
  const transcript = await transcriptOf([
    turn({ input: 4, cacheRead: 70_000 }),
    ...Array.from({ length: 30 }, () => output),
  ])

  expect(await sizeOf(transcript)).toBe(70_004)
})

it('has no size for a session with no assistant turn yet', async () => {
  const transcript = await transcriptOf([prompt('hello')])

  expect(await sizeOf(transcript)).toBeUndefined()
})

it('reads a transcript again only once it has changed', async () => {
  const transcript = await transcriptOf([turn({ input: 1, cacheRead: 10_000 })])
  const reader = createContextReader()
  const read = async (current: Transcript): Promise<number | undefined> =>
    (await reader.read({ transcripts: new Map([['abc', current]]) })).get('abc')?.tokens

  expect(await read(transcript)).toBe(10_001)

  // Same length and the same write time: what the board sees for a file that
  // has not been touched.
  await writeFile(transcript.path, `${turn({ input: 2, cacheRead: 10_000 })}\n`)
  await utimes(transcript.path, transcript.modifiedMs / 1000, transcript.modifiedMs / 1000)
  expect(await read(await describe(transcript.path))).toBe(10_001)

  await utimes(transcript.path, 1_900_000_000, 1_900_000_000)
  expect(await read(await describe(transcript.path))).toBe(10_002)
})
