import { type FSWatcher, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.js'
import type { Board } from './derive/board.js'
import { listProgressCandidates, resolveRepoRoot } from './derive/progress-files.js'
import { createEventLogReader } from './events/read.js'
import type { HookEvent } from './events/types.js'
import { openFile, openSessionTab } from './launch.js'
import { createMetadataStore } from './metadata/store.js'
import type { MetadataPatch } from './metadata/types.js'
import { findRequestRejection, isSessionId } from './request-guard.js'
import { buildSnapshot, resolveSessionCwd } from './snapshot.js'
import { openBodySchema, patchBodySchema } from './wire.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// Long enough that an editor's save (which fires several events) collapses into
// one rebuild, short enough that the panel still feels live.
const REBUILD_DEBOUNCE_MS = 150

const MAX_BODY_BYTES = 64 * 1024

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
 * Turn a request body into a metadata change.
 *
 * `null` on the wire means clear the field; a key left out means leave it be.
 * A body that does not parse writes nothing at all.
 */
function toPatch(body: unknown): MetadataPatch {
  const parsed = patchBodySchema.safeParse(body)
  if (!parsed.success) return {}

  const patch: MetadataPatch = {}

  for (const field of PATCH_FIELDS) {
    if (!(field in parsed.data)) continue

    // An empty string reaches here from a field edited down to nothing, and
    // means the same as `null`.
    patch[field] = parsed.data[field] || undefined
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
  const reader = createEventLogReader({ path: config.eventLogPath })
  const streams = new Set<ServerResponse>()

  let events: HookEvent[] = []
  let rebuildTimer: NodeJS.Timeout | undefined
  let loaded: Promise<void> | undefined
  let watcher: FSWatcher | undefined

  // Reading the log takes a moment, and a request that arrives first would
  // otherwise be answered from zero events: an empty board, and no migration of
  // the sessions that were cleared. Every handler waits on the same load.
  function ensureLoaded(): Promise<void> {
    loaded ??= reader.readAll().then(({ events: initial }) => {
      events = initial

      // Watch the directory, not the file. The log may not exist yet, and a
      // watch bound to one inode stops firing after a replace.
      watcher = watch(dirname(config.eventLogPath), scheduleRebuild)
    })

    return loaded
  }

  function snapshot(): Promise<Board> {
    return buildSnapshot({ events, store, config })
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

      await openSessionTab({
        sessionId,
        cwd: body.data.cwd,
        commandTemplate: config.launchCommand,
      })
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
      const merged = await store.patch({
        sessionId,
        // Editing a row is what puts a session that was taken off the board
        // back on it.
        changes: { ...toPatch(await readBody(req)), isDismissed: undefined },
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
    watcher?.close()
    watcher = undefined

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
