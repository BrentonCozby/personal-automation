import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createConnection, createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import type { Config } from './config.js'
import type { Board } from './derive/board.js'
import { findProgressFiles } from './derive/progress-files.js'
import { openNewSession, openSessionFromProgress } from './launch.js'
import { createBoardServer } from './server.js'

// Launching is the one thing a request does outside this process: it opens a
// terminal tab. Everything up to that point runs for real.
vi.mock('./launch.js', () => ({
  openFile: vi.fn(),
  openNewSession: vi.fn(),
  openSessionFromProgress: vi.fn(),
  openSessionTab: vi.fn(),
}))

const execFileAsync = promisify(execFile)

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  vi.useRealTimers()
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
  groups,
  transcriptRoots = [],
}: {
  events?: Record<string, unknown>[]
  metadata?: Record<string, unknown>
  groups?: string[]
  transcriptRoots?: string[]
} = {}): Promise<{
  origin: string
  metadataPath: string
  groupsPath: string
  port: number
  close: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-'))
  const eventLogPath = join(dir, 'events.jsonl')
  await writeFile(eventLogPath, events.map(event => `${JSON.stringify(event)}\n`).join(''))

  if (metadata) await writeFile(join(dir, 'sessions.json'), JSON.stringify(metadata))
  if (groups) await writeFile(join(dir, 'groups.json'), JSON.stringify(groups))

  const port = await findFreePort()
  const config: Config = {
    eventLogPath,
    metadataPath: join(dir, 'sessions.json'),
    groupsPath: join(dir, 'groups.json'),
    port,
    staleDays: 4,
    freshMinutes: 15,
    launchCommand: 'claude --resume {{id}}',
    openFileCommand: 'code -- {{path}}',
    progressCommand: 'claude -n {{name}} {{prompt}}',
    progressPrompt: 'Read {{progress}} and carry on.',
    transcriptRoots,
  }

  const board = createBoardServer({ config })
  await new Promise<void>(resolve => {
    board.server.listen(port, '127.0.0.1', resolve)
  })
  closers.push(() => board.close())

  return {
    origin: `http://127.0.0.1:${port}`,
    metadataPath: config.metadataPath,
    groupsPath: config.groupsPath,
    port,
    close: () => board.close(),
  }
}

/**
 * Open an event stream and keep every frame it sends.
 *
 * The count matters as much as the content: a test that only reads the newest
 * frame cannot tell a push that happened from one that never did.
 */
async function openFrames(port: number): Promise<{ socket: Socket; frames: Board[] }> {
  const frames: Board[] = []
  let buffer = ''
  let onFrame: (() => void) | undefined

  const socket = createConnection({ port, host: '127.0.0.1' })
  socket.on('data', chunk => {
    buffer += chunk.toString()
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      // The response headers arrive glued to the first frame, so the payload is
      // the one line inside a part that starts with `data: `.
      const line = part.split('\n').find(one => one.startsWith('data: '))
      if (line) frames.push(JSON.parse(line.slice('data: '.length)))
    }
    onFrame?.()
  })

  await new Promise<void>(resolve => socket.once('connect', resolve))
  socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n')
  await new Promise<void>(resolve => {
    onFrame = resolve
  })

  return { socket, frames }
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

it('rebuilds on a timer, with no file it watches having changed', async () => {
  // `Date` is faked alongside the interval so the board really does come out
  // different on the tick. Nothing on disk moves: the drawer drops a session
  // once it is more than seven days old, and that is the clock alone.
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
  const startedAt = 1_700_000_000
  const sevenDays = 7 * 24 * 60 * 60
  vi.setSystemTime(startedAt * 1000)

  const board = await startBoard({
    // Unclaimed, with a minute left of the window it is drawn in. The prompt is
    // what keeps it in the drawer at all: a session nobody asked anything and
    // nothing named is dropped whatever its age.
    events: [
      { session_id: 'abc', hook_event_name: 'UserPromptSubmit', t: startedAt - sevenDays + 60 },
    ],
  })
  const stream = await openFrames(board.port)
  expect(stream.frames[0]?.unclaimed).toHaveLength(1)

  vi.setSystemTime((startedAt + 120) * 1000)
  await vi.advanceTimersByTimeAsync(10_000)
  await new Promise(resolve => setTimeout(resolve, 150))

  // Frame count, not just content: without the timer this stays at the one
  // frame the stream opened with, and the drawer keeps the row for good.
  expect(stream.frames).toHaveLength(2)
  expect(stream.frames[1]?.unclaimed).toHaveLength(0)
  stream.socket.destroy()
})

it('sends nothing on a tick that leaves the board exactly as it was', async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] })

  const board = await startBoard({
    events: [{ session_id: 'abc', hook_event_name: 'SessionStart', t: 1_700_000_000 }],
    metadata: { abc: { name: 'impact-scoring' } },
  })
  const stream = await openFrames(board.port)

  await vi.advanceTimersByTimeAsync(30_000)

  expect(stream.frames).toHaveLength(1)
  stream.socket.destroy()
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

it('clears the group when one is renamed to Ungrouped rather than storing that word', async () => {
  const board = await startBoard({ metadata: { abc: { name: 'soc2', group: 'Bug week' } } })

  const res = await fetch(`${board.origin}/api/sessions/abc`, {
    method: 'PATCH',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'Ungrouped' }),
  })

  // Storing it would stand a second heading of that name beside the one
  // buildBoard invents for the rows that have no group.
  expect(res.status).toBe(200)
  expect(await readMetadata(board.metadataPath)).toEqual({ abc: { name: 'soc2' } })
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

/** A request to the group endpoints, which take a name rather than a session id. */
function groupRequest({
  origin,
  path,
  method,
  body,
}: {
  origin: string
  path: string
  method: string
  body?: unknown
}): Promise<Response> {
  return fetch(`${origin}/api/groups${path}`, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

it('creates a group that has no sessions in it yet', async () => {
  const board = await startBoard()

  const res = await groupRequest({
    origin: board.origin,
    path: '',
    method: 'POST',
    body: { name: 'Bug week' },
  })

  expect(res.status).toBe(200)
  expect(await readMetadata(board.groupsPath)).toEqual(['Bug week'])
})

it('refuses a second group of the same name', async () => {
  const board = await startBoard({ groups: ['Bug week'] })

  const res = await groupRequest({
    origin: board.origin,
    path: '',
    method: 'POST',
    body: { name: 'Bug week' },
  })

  expect(res.status).toBe(409)
  expect(await readMetadata(board.groupsPath)).toEqual(['Bug week'])
})

it('refuses Ungrouped as a group name, and says why', async () => {
  const board = await startBoard()

  const res = await groupRequest({
    origin: board.origin,
    path: '',
    method: 'POST',
    body: { name: 'ungrouped' },
  })

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: 'Ungrouped is where a row with no group goes, so it cannot be a group',
  })
})

it('renames a group and every row in it at once', async () => {
  const board = await startBoard({
    groups: ['Bug week'],
    metadata: { abc: { name: 'impact', group: 'Bug week' }, xyz: { name: 'loose' } },
  })

  const res = await groupRequest({
    origin: board.origin,
    path: `/${encodeURIComponent('Bug week')}`,
    method: 'PATCH',
    body: { name: 'Bug month' },
  })

  expect(res.status).toBe(200)
  expect(await readMetadata(board.groupsPath)).toEqual(['Bug month'])
  // Both halves move together: the snapshot registers every group it meets on a
  // row, so a row left behind would bring the old name straight back.
  expect(await readMetadata(board.metadataPath)).toEqual({
    abc: { name: 'impact', group: 'Bug month' },
    xyz: { name: 'loose' },
  })
})

it('deletes a group and drops its rows into Ungrouped', async () => {
  const board = await startBoard({
    groups: ['Bug week'],
    metadata: { abc: { name: 'impact', group: 'Bug week' } },
  })

  const res = await groupRequest({
    origin: board.origin,
    path: `/${encodeURIComponent('Bug week')}`,
    method: 'DELETE',
  })

  expect(res.status).toBe(200)
  expect(await readMetadata(board.groupsPath)).toEqual([])
  expect(await readMetadata(board.metadataPath)).toEqual({ abc: { name: 'impact' } })
})

/** A real repository, since resolveRepoRoot runs git for real. */
async function gitRepo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-board-repo-')))
  await execFileAsync('git', ['-C', root, 'init', '-q'])

  return root
}

function postSession(board: { origin: string }, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${board.origin}/api/sessions`, {
    method: 'POST',
    headers: { origin: board.origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

it('offers the repo roots the directories in the log collapse onto', async () => {
  const root = await gitRepo()
  const nested = join(root, 'apps', 'web')
  await execFileAsync('mkdir', ['-p', nested])
  const board = await startBoard({
    events: [
      { session_id: 'a', hook_event_name: 'SessionStart', t: 1, cwd: root },
      { session_id: 'b', hook_event_name: 'SessionStart', t: 2, cwd: nested },
    ],
  })

  const res = await fetch(`${board.origin}/api/repos`)

  // One root, not two directories: the subdirectory collapsed onto it.
  expect(await res.json()).toEqual({ repos: [root] })
})

it('starts a session under a pending row carrying the name and the group', async () => {
  const root = await gitRepo()
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    group: 'Bug week',
    cwd: root,
    createProgressFile: false,
  })
  const answer = (await res.json()) as { sessionId: string }

  expect(res.status).toBe(200)
  expect(answer.sessionId).toMatch(/^pending-/)
  expect(await readMetadata(board.metadataPath)).toEqual({
    [answer.sessionId]: {
      name: 'review-perf',
      group: 'Bug week',
      // No lastActive: a placeholder id has no transcript, so a row that drew
      // straight away would appear struck through with a dead resume button.
      relaunchedAt: expect.any(Number),
    },
  })
})

it('writes the progress file at the repo root and links the row to it', async () => {
  const root = await gitRepo()
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: root,
    createProgressFile: true,
  })
  const answer = (await res.json()) as { progressPath: string; isProgressFileNew: boolean }

  expect(answer.progressPath).toBe(join(root, 'review-perf.progress.local.md'))
  expect(answer.isProgressFileNew).toBe(true)
  expect(await readFile(answer.progressPath, 'utf8')).toMatch(/^# Review perf\n/)
})

it('tells a session with a brand new progress file nothing at all', async () => {
  const root = await gitRepo()
  const board = await startBoard()

  await postSession(board, { name: 'review-perf', cwd: root, createProgressFile: true })

  // An empty file is nothing to carry on from, and a first prompt would be
  // answered before the task had been typed.
  expect(vi.mocked(openNewSession).mock.calls.at(-1)?.[0]).toMatchObject({
    name: 'review-perf',
    prompt: undefined,
    cwd: root,
  })
})

it('tells a session to carry on when the progress file already held work', async () => {
  const root = await gitRepo()
  const existing = join(root, 'review-perf.progress.local.md')
  await writeFile(existing, 'half done\n')
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: root,
    createProgressFile: true,
  })

  expect(await res.json()).toMatchObject({ isProgressFileNew: false })
  expect(await readFile(existing, 'utf8')).toBe('half done\n')
  expect(vi.mocked(openNewSession).mock.calls.at(-1)?.[0]).toMatchObject({
    prompt: `Read ${existing} and carry on.`,
  })
})

it('starts no progress file when the box is unchecked', async () => {
  const root = await gitRepo()
  const board = await startBoard()

  await postSession(board, { name: 'review-perf', cwd: root, createProgressFile: false })

  expect(await findProgressFiles(root)).toEqual([])
  expect(vi.mocked(openNewSession).mock.calls.at(-1)?.[0]).toMatchObject({ prompt: undefined })
})

it('launches at the repo root when a worktree was typed, and says which root', async () => {
  const root = await gitRepo()
  await execFileAsync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'first'])
  const worktree = join(await realpath(await mkdtemp(join(tmpdir(), 'session-board-wt-'))), 'side')
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '-q', worktree, '-b', 'side'])
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: worktree,
    createProgressFile: true,
  })
  const answer = (await res.json()) as { cwd: string; progressPath: string }

  // Corrected rather than refused, and the answer names the root so the
  // correction is visible.
  expect(answer.cwd).toBe(root)
  expect(answer.progressPath).toBe(join(root, 'review-perf.progress.local.md'))
  expect(vi.mocked(openNewSession).mock.calls.at(-1)?.[0]).toMatchObject({ cwd: root })
})

it('refuses a directory that is in no repository', async () => {
  const plain = await realpath(await mkdtemp(join(tmpdir(), 'session-board-plain-')))
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: plain,
    createProgressFile: true,
  })

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: `${plain} is not in a git repository` })
  expect(await readMetadata(board.metadataPath)).toBeUndefined()
})

it('refuses a relative directory', async () => {
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: 'Code/marketplace',
    createProgressFile: true,
  })

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'a working directory has to be an absolute path' })
})

it('refuses a name another row on the board already holds', async () => {
  const root = await gitRepo()
  const board = await startBoard({ metadata: { abc: { name: 'review-perf' } } })

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: root,
    createProgressFile: true,
  })

  // The relaunch pairing keys on the name, so two rows waiting under one would
  // race for the same SessionStart.
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'review-perf is already on the board' })
  expect(await findProgressFiles(root)).toEqual([])
})

it('lets a name a superseded row left behind be used again', async () => {
  const root = await gitRepo()
  const board = await startBoard({
    metadata: { abc: { name: 'review-perf', supersededBy: 'def' } },
  })

  const res = await postSession(board, {
    name: 'review-perf',
    cwd: root,
    createProgressFile: false,
  })

  expect(res.status).toBe(200)
})

it('refuses a session name that is not kebab-case', async () => {
  const root = await gitRepo()
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'Review Perf',
    cwd: root,
    createProgressFile: true,
  })

  expect(res.status).toBe(400)
  expect(await findProgressFiles(root)).toEqual([])
})

it('stores no group at all for a session started from Ungrouped', async () => {
  const root = await gitRepo()
  const board = await startBoard()

  const res = await postSession(board, {
    name: 'review-perf',
    group: 'Ungrouped',
    cwd: root,
    createProgressFile: false,
  })
  const { sessionId } = (await res.json()) as { sessionId: string }

  // Ungrouped is the absence of a group, so storing the word would draw a
  // second heading of that name beside the one buildBoard invents.
  expect(await readMetadata(board.metadataPath)).toEqual({
    [sessionId]: { name: 'review-perf', relaunchedAt: expect.any(Number) },
  })
})

it('takes the row back when the tab could not be opened', async () => {
  const root = await gitRepo()
  const board = await startBoard()
  vi.mocked(openNewSession).mockRejectedValueOnce(new Error('Ghostty would not open a tab'))

  const failed = await postSession(board, {
    name: 'review-perf',
    cwd: root,
    createProgressFile: true,
  })

  expect(failed.status).toBe(500)
  // The row is written before the launch so the session about to start can be
  // paired with it. No session started, so nothing will ever pair, and the row
  // carries no `lastActive` and so draws nothing: left behind it would hold the
  // name against every later attempt with no row on screen to delete.
  expect(await readMetadata(board.metadataPath)).toEqual({})
  // The file was written for that session too. Left behind, the next attempt
  // would find it already there and tell its session to carry on from a
  // template holding nothing.
  expect(await findProgressFiles(root)).toEqual([])

  const second = await postSession(board, {
    name: 'review-perf',
    cwd: root,
    createProgressFile: true,
  })

  expect(second.status).toBe(200)
  expect(await second.json()).toMatchObject({ isProgressFileNew: true })
})
