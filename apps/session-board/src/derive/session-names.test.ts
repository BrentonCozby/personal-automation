import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import {
  createSessionNamer,
  findEventTitles,
  findTranscriptPaths,
  nameFromPrompt,
} from './session-names.js'

function event(overrides: Partial<HookEvent> & { session_id: string }): HookEvent {
  return { hook_event_name: 'SessionStart', t: 1_700_000_000, ...overrides }
}

async function transcript(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'session-board-names-'))
  const path = join(directory, 'aaa.jsonl')
  await writeFile(path, lines.map(line => `${JSON.stringify(line)}\n`).join(''))

  return path
}

it('reads the title Claude Code recorded, in kebab-case', () => {
  const titles = findEventTitles({
    events: [event({ session_id: 'aaa', session_title: 'Edit customer hidden error' })],
  })

  expect(titles.get('aaa')).toBe('edit-customer-hidden-error')
})

it('keeps the last title a session reported, since a rename replaces it', () => {
  const titles = findEventTitles({
    events: [
      event({ session_id: 'aaa', session_title: 'first' }),
      event({ session_id: 'aaa', session_title: 'second' }),
    ],
  })

  expect(titles.get('aaa')).toBe('second')
})

it('drops the number Claude Code adds to a title a second window is already using', () => {
  const titles = findEventTitles({
    events: [event({ session_id: 'aaa', session_title: 'technical-interview-round (2)' })],
  })

  // `technical-interview-round-2` reads as a second job, gets its own row, and
  // links to the same progress file as the first.
  expect(titles.get('aaa')).toBe('technical-interview-round')
})

it('has no title for a session that never reported one', () => {
  const titles = findEventTitles({ events: [event({ session_id: 'aaa' })] })

  expect(titles.has('aaa')).toBe(false)
})

it('cuts a prompt down to the first few words', () => {
  expect(nameFromPrompt('For each task below, invoke the project skill you would load')).toBe(
    'for-each-task-below',
  )
})

it('keeps a prompt that is already short whole', () => {
  expect(nameFromPrompt('best sandwich?')).toBe('best-sandwich')
})

it('has no name for a prompt with no words in it', () => {
  expect(nameFromPrompt('!!! ???')).toBe(undefined)
})

it('names a session from the title in its transcript', async () => {
  const path = await transcript([
    { type: 'custom-title', customTitle: 'bug-2260-cart-green-thumb' },
    { type: 'user', message: { content: 'what is 2+2' } },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'bug-2260-cart-green-thumb']]),
  )
})

it('falls back to the first thing you asked it', async () => {
  const path = await transcript([{ type: 'user', message: { content: 'best sandwich?' } }])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

it('reads a prompt sent as content blocks, not just as a string', async () => {
  const path = await transcript([
    { type: 'user', message: { content: [{ type: 'text', text: 'best sandwich?' }] } },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

// Every `/clear` writes one of these into the new session's transcript, and a
// session abandoned straight after a clear holds nothing else. Naming it
// `local-command-caveat-the-messages-below` would put that on thirteen rows.
it('steps over the markup Claude Code writes into the transcript itself', async () => {
  const path = await transcript([
    { type: 'user', message: { content: '<local-command-caveat>Caveat: the messages below' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { content: 'best sandwich?' } },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

// A subagent's turns are written into the transcript of the session that
// spawned it, so the first one is often the task a subagent was handed rather
// than anything the person typed.
it('ignores a subagent turn', async () => {
  const path = await transcript([
    { type: 'user', isSidechain: true, message: { content: 'run the tests' } },
    { type: 'user', message: { content: 'best sandwich?' } },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

it('ignores a tool result, which is not something you typed', async () => {
  const path = await transcript([
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', message: { content: 'best sandwich?' } },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

// A record carries the title as well as the turn, so a message shape this does
// not know must not take the whole record with it.
it('still reads the title off a record whose message it cannot make sense of', async () => {
  const path = await transcript([
    { type: 'custom-title', customTitle: 'kept-anyway', message: { content: 42 } },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'kept-anyway']]),
  )
})

it('reads the typed part of a turn that also carries a tool result', async () => {
  const path = await transcript([
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: 'ok' },
          { type: 'text', text: 'best sandwich?' },
        ],
      },
    },
  ])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

it('names nothing for a session whose transcript holds no prompt', async () => {
  const path = await transcript([{ type: 'summary', summary: 'a summary' }])
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map(),
  )
})

// The title is the only name left for a session whose transcript has been
// deleted, and reading a file to second-guess it would cost more and say less.
it('takes the title a session reported over anything in its transcript', async () => {
  const path = await transcript([{ type: 'custom-title', customTitle: 'from-the-transcript' }])
  const namer = createSessionNamer()

  expect(
    await namer.derive({
      sessions: [{ sessionId: 'aaa', transcriptPaths: [path], title: 'from-the-log' }],
    }),
  ).toEqual(new Map([['aaa', 'from-the-log']]))
})

it('names a session by its title with no transcript on disk at all', async () => {
  const namer = createSessionNamer()

  expect(
    await namer.derive({
      sessions: [{ sessionId: 'aaa', transcriptPaths: [], title: 'board-start-probe' }],
    }),
  ).toEqual(new Map([['aaa', 'board-start-probe']]))
})

// Renaming a session emits a new title, so a remembered one would outlive the
// name it stood for.
it('follows a title that changed, rather than remembering the old one', async () => {
  const namer = createSessionNamer()
  await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [], title: 'first' }] })

  expect(
    await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [], title: 'second' }] }),
  ).toEqual(new Map([['aaa', 'second']]))
})

it('names nothing for a session with no transcript on disk', async () => {
  const namer = createSessionNamer()

  expect(
    await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: ['/nope/aaa.jsonl'] }] }),
  ).toEqual(new Map())
})

// A session written under both project roots reports both paths, and only one
// of them is still on disk once an account is retired.
it('tries every path a session reported until one opens', async () => {
  const path = await transcript([{ type: 'user', message: { content: 'best sandwich?' } }])
  const namer = createSessionNamer()

  expect(
    await namer.derive({
      sessions: [{ sessionId: 'aaa', transcriptPaths: ['/nope/aaa.jsonl', path] }],
    }),
  ).toEqual(new Map([['aaa', 'best-sandwich']]))
})

it('tries the path a session reported last before the one it reported first', () => {
  const paths = findTranscriptPaths({
    events: [
      event({ session_id: 'aaa', transcript_path: '/work/aaa.jsonl' }),
      event({ session_id: 'aaa', transcript_path: '/personal/aaa.jsonl' }),
      event({ session_id: 'aaa', transcript_path: '/work/aaa.jsonl' }),
    ],
  })

  expect(paths.get('aaa')).toEqual(['/work/aaa.jsonl', '/personal/aaa.jsonl'])
})

it('steps over a line that is not JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-board-names-'))
  const path = join(directory, 'aaa.jsonl')
  await writeFile(
    path,
    `{ half a line\n${JSON.stringify({ type: 'user', message: { content: 'best sandwich?' } })}\n`,
  )
  const namer = createSessionNamer()

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

// The first prompt of a session never changes, so re-reading 300 transcripts on
// every snapshot buys nothing. Proven by deleting the file and asking again.
it('reads a transcript once and remembers the answer', async () => {
  const path = await transcript([{ type: 'user', message: { content: 'best sandwich?' } }])
  const namer = createSessionNamer()
  await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })
  await writeFile(path, JSON.stringify({ type: 'user', message: { content: 'other question' } }))

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})

// A session that has started but not yet been asked anything has a transcript
// with no prompt in it. Remembering that would leave the row unnamed for good.
it('asks again for a session that had nothing to name it by', async () => {
  const path = await transcript([{ type: 'summary', summary: 'a summary' }])
  const namer = createSessionNamer()
  await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })
  await writeFile(path, JSON.stringify({ type: 'user', message: { content: 'best sandwich?' } }))

  expect(await namer.derive({ sessions: [{ sessionId: 'aaa', transcriptPaths: [path] }] })).toEqual(
    new Map([['aaa', 'best-sandwich']]),
  )
})
