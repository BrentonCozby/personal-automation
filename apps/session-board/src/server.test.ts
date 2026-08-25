import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createConnection, createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import type { Config } from './config.js'
import { openSessionFromProgress } from './launch.js'
import { createBoardServer } from './server.js'

// Launching is the one thing a request does outside this process: it opens a
// terminal tab. Everything up to that point runs for real.
vi.mock('./launch.js', () => ({
  openFile: vi.fn(),
  openSessionFromProgress: vi.fn(),
  openSessionTab: vi.fn(),
}))

const execFileAsync = promisify(execFile)

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function findFreePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>(resolve => {
    probe.listen(0, '127.0.0.1', resolve)
  })

  const address = probe.address()
  if (typeof address !== 'object' || address === null) throw new Error('no port assigned')

  const { port } = address
  await new Promise<void>(resolve => probe.close(() => resolve()))

  return port
}

async function startBoard({
  events = [],
  metadata,
}: {
  events?: Record<string, unknown>[]
  metadata?: Record<string, unknown>
} = {}): Promise<{
  origin: string
  metadataPath: string
  port: number
  close: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-'))
  const eventLogPath = join(dir, 'events.jsonl')
  await writeFile(eventLogPath, events.map(event => `${JSON.stringify(event)}\n`).join(''))

  if (metadata) await writeFile(join(dir, 'sessions.json'), JSON.stringify(metadata))

  const port = await findFreePort()
  const config: Config = {
    eventLogPath,
    metadataPath: join(dir, 'sessions.json'),
    port,
    staleDays: 4,
    freshMinutes: 15,
    launchCommand: 'claude --resume {{id}}',
    openFileCommand: 'code -- {{path}}',
    progressCommand: 'claude -n {{name}} {{prompt}}',
    progressPrompt: 'Read {{progress}} and carry on.',
    transcriptRoots: [],
  }

  const board = createBoardServer({ config })
  await new Promise<void>(resolve => {
    board.server.listen(port, '127.0.0.1', resolve)
  })
  closers.push(() => board.close())

  return {
    origin: `http://127.0.0.1:${port}`,
    metadataPath: config.metadataPath,
    port,
    close: () => board.close(),
  }
}

/** Resolves once the first frame has arrived, so the stream is really open. */
function openEventStream(port: number): Promise<Socket> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n')
    })
    socket.once('data', () => resolve(socket))
  })
}

async function isPortFree(port: number): Promise<boolean> {
  const probe = createNetServer()
  const listened = await new Promise<boolean>(resolve => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => resolve(true))
  })
  await new Promise<void>(resolve => probe.close(() => resolve()))

  return listened
}

async function readMetadata(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

it('writes nothing at all when a field of the body is the wrong type', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 42, group: 'Bug week' }),
  })

  // Refused whole rather than half-applied, and said so: writing nothing behind
  // a 200 reads as an edit that quietly did not take.
  expect(res.status).toBe(400)
  expect(await readMetadata(board.metadataPath)).toBeUndefined()
})

it('refuses a session name that is not kebab-case, and says which rule', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Impact Scoring' }),
  })

  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: expect.stringContaining('kebab-case') })
  expect(await readMetadata(board.metadataPath)).toBeUndefined()
})

it('still lets a name be cleared, which is how a row is unclaimed', async () => {
  const board = await startBoard({ metadata: { abc: { name: 'impact-scoring' } } })

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: null }),
  })

  expect(res.status).toBe(200)
  expect(await readMetadata(board.metadataPath)).toEqual({ abc: {} })
})

it('gives the port back even with an event stream still open', async () => {
  const board = await startBoard()
  const stream = await openEventStream(board.port)

  await board.close()
  stream.destroy()

  expect(await isPortFree(board.port)).toBe(true)
})

it('lists the progress files of the repo the session was working in', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-board-repo-')))
  await execFileAsync('git', ['-C', root, 'init', '-q'])
  await writeFile(join(root, 'a-task.progress.local.md'), '')

  const board = await startBoard({
    events: [{ hook_event_name: 'SessionStart', session_id: 'abc', t: 1, cwd: root }],
  })

  const res = await fetch(`${board.origin}/api/sessions/abc/progress-candidates`)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    files: [{ path: join(root, 'a-task.progress.local.md'), slug: 'a-task' }],
  })
})

it('takes the directory from the session, not from a directory the caller names', async () => {
  const own = await realpath(await mkdtemp(join(tmpdir(), 'session-board-own-')))
  const other = await realpath(await mkdtemp(join(tmpdir(), 'session-board-other-')))
  await execFileAsync('git', ['-C', own, 'init', '-q'])
  await execFileAsync('git', ['-C', other, 'init', '-q'])
  await writeFile(join(own, 'mine.progress.local.md'), '')
  await writeFile(join(other, 'theirs.progress.local.md'), '')

  const board = await startBoard({
    events: [{ hook_event_name: 'SessionStart', session_id: 'abc', t: 1, cwd: own }],
  })

  const res = await fetch(
    `${board.origin}/api/sessions/abc/progress-candidates?cwd=${encodeURIComponent(other)}`,
  )

  expect(await res.json()).toEqual({
    files: [{ path: join(own, 'mine.progress.local.md'), slug: 'mine' }],
  })
})

it('falls back to the directory stored on an imported row that has no events', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-board-imported-')))
  await execFileAsync('git', ['-C', root, 'init', '-q'])
  await writeFile(join(root, 'a-task.progress.local.md'), '')

  const board = await startBoard({ metadata: { abc: { name: 'imported', cwd: root } } })

  const res = await fetch(`${board.origin}/api/sessions/abc/progress-candidates`)

  expect(await res.json()).toEqual({
    files: [{ path: join(root, 'a-task.progress.local.md'), slug: 'a-task' }],
  })
})

it('says so rather than guessing when a session has no directory recorded', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc/progress-candidates`)

  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'no working directory recorded' })
})

it('refuses a POST carrying another site as its origin', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc/open`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp' }),
  })

  expect(res.status).toBe(403)
})

it('refuses the form-shaped POST that reaches a localhost port with no preflight', async () => {
  const board = await startBoard()

  // What a hostile page can send without the browser asking permission first:
  // a form POST, text/plain, whose body happens to parse as JSON.
  const res = await fetch(`${board.origin}/api/sessions/abc/open`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: '{"cwd":"/tmp","z":"="}',
  })

  expect(res.status).toBe(403)
})

it('refuses a body that is not json even when no origin is sent', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc/open`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"cwd":"/tmp"}',
  })

  expect(res.status).toBe(415)
})

it('refuses a session id that would not survive substitution into the launch command', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/x%3B%20touch%20%2Ftmp%2Fpwned/open`, {
    method: 'POST',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp' }),
  })

  expect(res.status).toBe(400)
})

it('refuses a cross-origin PATCH before it can write metadata', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'OWNED' }),
  })

  expect(res.status).toBe(403)
  expect(await readMetadata(board.metadataPath)).toBeUndefined()
})

it('refuses a cross-origin DELETE', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'DELETE',
    headers: { origin: 'https://evil.example' },
  })

  expect(res.status).toBe(403)
})

it('accepts a PATCH from the board page itself', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'impact-scoring' }),
  })

  expect(res.status).toBe(200)
  expect(await readMetadata(board.metadataPath)).toEqual({ abc: { name: 'impact-scoring' } })
})

it('accepts a json content-type that carries a charset', async () => {
  const board = await startBoard()

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: board.origin, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: 'impact-scoring' }),
  })

  expect(res.status).toBe(200)
})

it('still serves the board page, which sends no origin of its own', async () => {
  const board = await startBoard()

  const res = await fetch(board.origin)

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
})

it('marks a row relaunched so the fresh session takes the row over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-progress-'))
  const progressPath = join(dir, 'soc2.progress.local.md')
  await writeFile(progressPath, '# soc2\n')

  const board = await startBoard({ metadata: { abc: { name: 'soc2', progressPath } } })

  const res = await fetch(`${board.origin}/api/sessions/abc/open`, {
    method: 'POST',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: dir }),
  })

  expect(res.status).toBe(200)
  expect(openSessionFromProgress).toHaveBeenCalledOnce()

  // Without this the new session claims itself from the name it was given and
  // the row that was clicked stays behind, showing the same name twice.
  const stored = (await readMetadata(board.metadataPath)) as {
    abc: { relaunchedAt?: number }
  }
  expect(stored.abc.relaunchedAt).toBeGreaterThan(0)
})

it('marks the row before the launch, so a fast session cannot start ahead of the mark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-progress-'))
  const progressPath = join(dir, 'soc2.progress.local.md')
  await writeFile(progressPath, '# soc2\n')

  const board = await startBoard({ metadata: { abc: { name: 'soc2', progressPath } } })

  // Opening the tab takes about a second and the session it starts fires its
  // first event moments later. A mark made after that returns is timed after
  // the event it is meant to catch, and the row is never paired with the
  // session it asked for.
  let markedBeforeLaunch: unknown
  vi.mocked(openSessionFromProgress).mockImplementationOnce(async () => {
    markedBeforeLaunch = ((await readMetadata(board.metadataPath)) as { abc: unknown }).abc
  })

  const res = await fetch(`${board.origin}/api/sessions/abc/open`, {
    method: 'POST',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: dir }),
  })

  expect(res.status).toBe(200)
  expect(markedBeforeLaunch).toMatchObject({ relaunchedAt: expect.any(Number) })
})
