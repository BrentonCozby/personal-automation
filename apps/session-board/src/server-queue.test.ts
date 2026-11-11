import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createConnection, createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Config } from './config.js'
import { createBoardServer } from './server.js'
import { buildSnapshot } from './snapshot.js'

// The first snapshot waits until a test lets it go, so a test can send an edit
// while one is in flight. Every later snapshot runs for real.
let releaseFirst: () => void = () => undefined
let isFirstHeld = true
vi.mock('./snapshot.js', async () => {
  const actual = await vi.importActual<typeof import('./snapshot.js')>('./snapshot.js')

  return {
    ...actual,
    buildSnapshot: vi.fn(async (input: Parameters<typeof actual.buildSnapshot>[0]) => {
      if (isFirstHeld) {
        isFirstHeld = false
        await new Promise<void>(resolve => (releaseFirst = resolve))
      }

      return actual.buildSnapshot(input)
    }),
  }
})

const closers: (() => Promise<void>)[] = []
const sockets: Socket[] = []

beforeEach(() => {
  isFirstHeld = true
  vi.mocked(buildSnapshot).mockClear()
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const close of closers.splice(0)) await close()
})

async function findFreePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await new Promise<void>(resolve => probe.close(() => resolve()))

  return address.port
}

async function startBoard({
  metadata,
  groups,
}: {
  metadata: Record<string, unknown>
  groups: string[]
}): Promise<{ origin: string; metadataPath: string; groupsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-queue-'))
  const config: Config = {
    eventLogPath: join(dir, 'events.jsonl'),
    metadataPath: join(dir, 'sessions.json'),
    groupsPath: join(dir, 'groups.json'),
    port: await findFreePort(),
    freshMinutes: 15,
    launchCommand: 'claude --resume {{id}}',
    openFileCommand: 'code -- {{path}}',
    progressCommand: 'claude -n {{name}} {{prompt}}',
    progressPrompt: 'Read {{progress}} and carry on.',
    subagentGrantPath: join(dir, 'subagent-grant.md'),
    noProgressNote: 'Do not create a progress file.',
    newProgressNote: 'A progress file is waiting at {{progress}}.',
    transcriptRoots: [],
  }
  await writeFile(config.eventLogPath, '')
  await writeFile(config.metadataPath, JSON.stringify(metadata))
  await writeFile(config.groupsPath, JSON.stringify(groups))

  const board = createBoardServer({ config })
  await new Promise<void>(resolve => board.server.listen(config.port, '127.0.0.1', resolve))
  closers.push(() => board.close())

  return {
    origin: `http://127.0.0.1:${config.port}`,
    metadataPath: config.metadataPath,
    groupsPath: config.groupsPath,
  }
}

/** Opens an event stream, which builds a snapshot, and waits until that snapshot has begun. */
async function holdASnapshot(origin: string): Promise<void> {
  const { port } = new URL(origin)
  const socket = createConnection({ port: Number(port), host: '127.0.0.1' }, () => {
    socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n')
  })
  sockets.push(socket)
  await vi.waitFor(() => {
    if (vi.mocked(buildSnapshot).mock.calls.length === 0) throw new Error('no snapshot yet')
  })
}

function patch({
  url,
  origin,
  body,
}: {
  url: string
  origin: string
  body: unknown
}): Promise<Response> {
  return fetch(url, {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

it.each([
  {
    case: 'a group rename',
    send: (origin: string) => patch({ url: `${origin}/api/groups/A`, origin, body: { name: 'B' } }),
    file: 'groupsPath' as const,
  },
  {
    case: 'a row move',
    send: (origin: string) =>
      patch({ url: `${origin}/api/sessions/a`, origin, body: { group: 'B', before: null } }),
    file: 'metadataPath' as const,
  },
])('waits for a snapshot in flight before writing $case', async ({ send, file }) => {
  const board = await startBoard({ metadata: { a: { group: 'A', lastActive: 1 } }, groups: ['A'] })
  const before = await readJson(board[file])

  await holdASnapshot(board.origin)
  const response = send(board.origin)
  // Unqueued, either edit writes within a few milliseconds.
  await new Promise(resolve => setTimeout(resolve, 200))
  const whileHeld = await readJson(board[file])
  releaseFirst()
  expect((await response).status).toBe(200)

  expect(whileHeld).toEqual(before)
  expect(await readJson(board[file])).not.toEqual(before)
})
