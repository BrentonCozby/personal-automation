import { type FSWatcher, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'
import type { Config } from './config.js'
import { type Board, UNGROUPED_LABEL } from './derive/board.js'
import { listProgressCandidates, resolveRepoRoot } from './derive/progress-files.js'
import { createEventLogReader } from './events/read.js'
import type { HookEvent } from './events/types.js'
import { openFile, openSessionFromProgress, openSessionTab } from './launch.js'
import { createGroupStore } from './metadata/group-store.js'
import { createMetadataStore } from './metadata/store.js'
import type { MetadataPatch } from './metadata/types.js'
import { findRequestRejection, isSessionId } from './request-guard.js'
import { buildSnapshot, fileExists, resolveSessionCwd } from './snapshot.js'
import { groupBodySchema, openBodySchema, patchBodySchema } from './wire.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// Long enough that an editor's save (which fires several events) collapses into
// one rebuild, short enough that the panel still feels live.
const REBUILD_DEBOUNCE_MS = 150

const MAX_BODY_BYTES = 64 * 1024

const MILLISECONDS_PER_SECOND = 1000

function sendJson({
  res,
  status,
  body,
}: {
  res: ServerResponse
  status: number
  body: unknown
}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(chunk)
  }

  if (chunks.length === 0) return undefined

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const PATCH_FIELDS = ['name', 'group', 'parkedReason', 'progressPath'] as const

/**
 * Turn a parsed request body into a metadata change.
 *
 * `null` on the wire means clear the field; a key left out means leave it be.
 */
function toPatch(body: z.infer<typeof patchBodySchema>): MetadataPatch {
  const patch: MetadataPatch = {}

  for (const field of PATCH_FIELDS) {
    if (!(field in body)) continue

    // An empty string reaches here from a field edited down to nothing, and
    // means the same as `null`.
    patch[field] = body[field] || undefined
  }

  // Ungrouped is the absence of a group, and `buildBoard` invents that heading
  // for the rows that have none. Storing the word would put a second heading of
  // the same name beside it, one renameable and one not. Renaming a group to it
  // is the way in: dragging onto it already clears the field.
  if (patch.group?.trim().toLowerCase() === UNGROUPED_LABEL.toLowerCase()) {
    patch.group = undefined
  }

  return patch
}

export interface BoardServer {
  server: Server
  /**
   * Stop listening, end the open event streams and drop the log watcher.
   *
   * The streams have to be ended by hand: `server.close()` waits for every
   * connection to finish and an event stream never finishes on its own, so
   * without this the port stays held. A listener left on 4747 does not just
   * waste a handle, it answers from the code it was started with, so the next
   * run looks like an edit that did not take.
   */
  close(): Promise<void>
}

export function createBoardServer({ config }: { config: Config }): BoardServer {
  const store = createMetadataStore({ path: config.metadataPath })
  const groups = createGroupStore({ path: config.groupsPath })
  const reader = createEventLogReader({ path: config.eventLogPath })
  const streams = new Set<ServerResponse>()

  let events: HookEvent[] = []
  let rebuildTimer: NodeJS.Timeout | undefined
  let loaded: Promise<void> | undefined
  let watchers: FSWatcher[] = []
  let isClosed = false

  // Reading the log takes a moment, and a request that arrives first would
  // otherwise be answered from zero events: an empty board, and no migration of
  // the sessions that were cleared. Every handler waits on the same load.
  function ensureLoaded(): Promise<void> {
    loaded ??= reader.readAll().then(({ events: initial }) => {
      events = initial

      // `close` can land while the log is still being read, and a watcher
      // started after it is one nobody will ever close.
      if (isClosed) return

      // Watch the directories, not the files. Neither may exist yet, and a
      // watch bound to one inode stops firing after a replace. Both are named
      // rather than only the log's: an edit to a row has to repaint the board
      // too, and the two files only share a directory by default.
      const directories = new Set([
        dirname(config.eventLogPath),
        dirname(config.metadataPath),
        dirname(config.groupsPath),
      ])
      watchers = [...directories].map(directory => watch(directory, scheduleRebuild))
    })

    return loaded
  }

  function snapshot(): Promise<Board> {
    return buildSnapshot({ events, store, groups, config })
  }

  async function pushToStreams(): Promise<void> {
    if (streams.size === 0) return

    const board = await snapshot()
    const frame = `data: ${JSON.stringify(board)}\n\n`
    for (const stream of streams) stream.write(frame)
  }

  async function ingestNewEvents(): Promise<void> {
    const { events: fresh } = await reader.readAppended()
    if (fresh.length > 0) events = [...events, ...fresh]
  }

  function scheduleRebuild(): void {
    if (rebuildTimer) clearTimeout(rebuildTimer)

    rebuildTimer = setTimeout(() => {
      void ingestNewEvents().then(pushToStreams)
    }, REBUILD_DEBOUNCE_MS)
  }

  /** Move every session in a group to another one, or out of any group at all. */
  async function moveRowsOutOf({
    group,
    to,
  }: {
    group: string
    to: string | undefined
  }): Promise<void> {
    const metadata = await store.read()
    const members = Object.entries(metadata)
      .filter(([, entry]) => entry.group === group)
      .map(([sessionId]) => sessionId)

    for (const sessionId of members) {
      await store.patch({ sessionId, changes: { group: to } })
    }
  }

  async function handleGroupApi({
    req,
    res,
    url,
  }: {
    req: IncomingMessage
    res: ServerResponse
    url: URL
  }): Promise<boolean> {
    const groupMatch = /^\/api\/groups(?:\/(.+))?$/.exec(url.pathname)
    if (!groupMatch) return false

    const name = groupMatch[1] === undefined ? undefined : decodeURIComponent(groupMatch[1])

    if (!name && req.method === 'POST') {
      const body = groupBodySchema.safeParse(await readBody(req))
      if (!body.success) {
        sendJson({ res, status: 400, body: { error: body.error.issues[0]?.message } })

        return true
      }

      const created = await groups.add(body.data.name)
      if (!created) {
        sendJson({ res, status: 409, body: { error: 'that group already exists' } })

        return true
      }

      sendJson({ res, status: 200, body: { name: body.data.name } })
      await pushToStreams()

      return true
    }

    if (name && req.method === 'PATCH') {
      const body = groupBodySchema.safeParse(await readBody(req))
      if (!body.success) {
        sendJson({ res, status: 400, body: { error: body.error.issues[0]?.message } })

        return true
      }

      // The rows carry the name too, so both halves move or the group splits in
      // two: the old name would come back on the next snapshot, which registers
      // every group it meets on a row.
      await groups.rename({ from: name, to: body.data.name })
      await moveRowsOutOf({ group: name, to: body.data.name })
      sendJson({ res, status: 200, body: { name: body.data.name } })
      await pushToStreams()

      return true
    }

    if (name && req.method === 'DELETE') {
      await groups.remove(name)
      await moveRowsOutOf({ group: name, to: undefined })
      sendJson({ res, status: 200, body: { ok: true } })
      await pushToStreams()

      return true
    }

    return false
  }

  async function handleApi({
    req,
    res,
    url,
  }: {
    req: IncomingMessage
    res: ServerResponse
    url: URL
  }): Promise<boolean> {
    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/[a-z-]+)?$/.exec(url.pathname)
    if (!sessionMatch) return false

    const sessionId = decodeURIComponent(sessionMatch[1] ?? '')
    const action = sessionMatch[2]

    // `%2F` gets past the path pattern and decodes back into a slash, so the id
    // is only known to be safe after decoding, not before.
    if (!isSessionId(sessionId)) {
      sendJson({ res, status: 400, body: { error: 'invalid session id' } })

      return true
    }

    if (action === '/open' && req.method === 'POST') {
      const body = openBodySchema.safeParse(await readBody(req))
      if (!body.success) {
        sendJson({ res, status: 400, body: { error: 'cwd is required to resume a session' } })

        return true
      }

      // A progress file is the durable state, so a row that has one gets a
      // clean session pointed at it rather than its old conversation reopened.
      // A file that has gone missing falls through to the old session, which is
      // then the only record of the work left.
      const entry = (await store.read())[sessionId]
      const progressPath = entry?.progressPath
      const name = entry?.name
      if (progressPath && name && (await fileExists(progressPath))) {
        // Written before the launch, not after. The session about to start is a
        // new id that shares nothing with this one, and this mark is the only
        // record that the two are the same work: the snapshot pairs them by
        // matching a SessionStart at or after it, so a mark made once the tab
        // is already up can miss the event it exists to catch. A launch that
        // then fails leaves the mark behind with no session to pair it to,
        // which costs nothing: it only ever matches a session that started.
        await store.patch({
          sessionId,
          changes: { relaunchedAt: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) },
        })

        await openSessionFromProgress({
          sessionId,
          name,
          progressPath,
          cwd: body.data.cwd,
          commandTemplate: config.progressCommand,
          promptTemplate: config.progressPrompt,
        })
      } else {
        await openSessionTab({
          sessionId,
          cwd: body.data.cwd,
          commandTemplate: config.launchCommand,
        })
      }
      sendJson({ res, status: 200, body: { ok: true } })

      return true
    }

    if (action === '/open-progress' && req.method === 'POST') {
      const metadata = await store.read()
      const path = metadata[sessionId]?.progressPath
      if (!path) {
        sendJson({ res, status: 404, body: { error: 'no progress file linked' } })

        return true
      }

      await openFile({ path, commandTemplate: config.openFileCommand })
      sendJson({ res, status: 200, body: { ok: true } })

      return true
    }

    if (action === '/progress-candidates' && req.method === 'GET') {
      // The directory comes from the session's own events, never from the
      // request. Taking it from the query string let any page in the browser
      // pick the directory this runs `git` in.
      const metadata = await store.read()
      const cwd = resolveSessionCwd({ events, metadata, sessionId })
      if (!cwd) {
        sendJson({ res, status: 404, body: { error: 'no working directory recorded' } })

        return true
      }

      const root = await resolveRepoRoot(cwd)
      sendJson({
        res,
        status: 200,
        body: {
          files: root ? await listProgressCandidates({ repoRoot: root, metadata, sessionId }) : [],
        },
      })

      return true
    }

    if (!action && req.method === 'PATCH') {
      const body = patchBodySchema.safeParse(await readBody(req))
      if (!body.success) {
        // Says which rule was broken rather than writing nothing and answering
        // 200, which reads as an edit that silently did not take.
        const reason = body.error.issues[0]?.message ?? 'invalid request body'
        sendJson({ res, status: 400, body: { error: reason } })

        return true
      }

      const merged = await store.patch({
        sessionId,
        // Editing a row is what puts a session that was taken off the board
        // back on it.
        changes: { ...toPatch(body.data), isDismissed: undefined },
      })
      sendJson({ res, status: 200, body: merged })
      await pushToStreams()

      return true
    }

    if (!action && req.method === 'DELETE') {
      await store.dismiss(sessionId)
      sendJson({ res, status: 200, body: { ok: true } })
      await pushToStreams()

      return true
    }

    return false
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rejection = findRequestRejection({
          method: req.method,
          origin: req.headers.origin,
          contentType: req.headers['content-type'],
          port: config.port,
        })
        if (rejection) {
          sendJson({ res, status: rejection.status, body: { error: rejection.error } })

          return
        }

        await ensureLoaded()
        const url = new URL(req.url ?? '/', `http://localhost:${config.port}`)

        if (url.pathname === '/' && req.method === 'GET') {
          const html = await readFile(join(HERE, 'web', 'index.html'), 'utf8')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(html)

          return
        }

        if (url.pathname === '/board.js' && req.method === 'GET') {
          const script = await readFile(join(HERE, 'web', 'board.js'), 'utf8')
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            // The file changes as often as the server restarts, and a stale copy
            // looks like an edit that did not take.
            'cache-control': 'no-store',
          })
          res.end(script)

          return
        }

        if (url.pathname === '/stream' && req.method === 'GET') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          streams.add(res)
          res.write(`data: ${JSON.stringify(await snapshot())}\n\n`)
          req.on('close', () => {
            streams.delete(res)
          })

          return
        }

        if (await handleGroupApi({ req, res, url })) return
        if (await handleApi({ req, res, url })) return

        sendJson({ res, status: 404, body: { error: 'not found' } })
      } catch (error) {
        sendJson({ res, status: 500, body: { error: (error as Error).message } })
      }
    })()
  })

  server.on('listening', () => {
    void ensureLoaded()
  })

  async function close(): Promise<void> {
    isClosed = true
    for (const watcher of watchers) watcher.close()
    watchers = []

    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = undefined

    for (const stream of streams) stream.end()
    streams.clear()

    if (!server.listening) return

    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  }

  return { server, close }
}
