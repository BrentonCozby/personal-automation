import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { metadataFileSchema } from './schemas.js'
import type { MetadataBySession, MetadataPatch, SessionMetadata } from './types.js'

export interface MetadataStore {
  read(): Promise<MetadataBySession>
  patch(input: { sessionId: string; changes: MetadataPatch }): Promise<SessionMetadata>
  /** Drop a row's annotations but leave a marker saying it was taken off the board. */
  dismiss(sessionId: string): Promise<void>
  remove(sessionId: string): Promise<void>
}

function withoutEmptyFields(metadata: SessionMetadata): SessionMetadata {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined)

  return Object.fromEntries(entries)
}

export function createMetadataStore({ path }: { path: string }): MetadataStore {
  let writeCount = 0
  let queue: Promise<unknown> = Promise.resolve()

  /**
   * Run mutations one at a time.
   *
   * Every mutation is a read, a merge and a write. Two of them overlapping lose
   * one of the two edits, and both racing on the same temporary file produced a
   * file that was one object followed by the tail of a longer one. Rejections
   * are swallowed from the queue only, so the caller still sees its own error
   * and one failure does not wedge every later write.
   */
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work)
    queue = result.catch(() => undefined)

    return result
  }

  async function read(): Promise<MetadataBySession> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}

      throw error
    }

    // A damaged file is thrown rather than treated as empty. Starting from
    // empty would look like a working board with no sessions on it, and the
    // next edit would write that emptiness back over the real annotations.
    return metadataFileSchema.parse(JSON.parse(text))
  }

  async function write(all: MetadataBySession): Promise<void> {
    await mkdir(dirname(path), { recursive: true })

    // Write beside the target and rename over it. rename is atomic within a
    // filesystem, so a crash mid-write leaves the previous file intact instead
    // of a half-written one. The counter keeps two writes from sharing a
    // temporary file and interleaving their bytes into it.
    writeCount += 1
    const temporaryPath = `${path}.${process.pid}.${writeCount}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  function patch({
    sessionId,
    changes,
  }: {
    sessionId: string
    changes: MetadataPatch
  }): Promise<SessionMetadata> {
    return serialize(async () => {
      // Re-read rather than caching: the file is small, and it is meant to be
      // hand-editable, so an edit made outside the app must not be clobbered.
      const all = await read()
      const merged = withoutEmptyFields({ ...all[sessionId], ...changes })

      await write({ ...all, [sessionId]: merged })

      return merged
    })
  }

  function dismiss(sessionId: string): Promise<void> {
    return serialize(async () => {
      const all = await read()

      await write({ ...all, [sessionId]: { isDismissed: true } })
    })
  }

  function remove(sessionId: string): Promise<void> {
    return serialize(async () => {
      const all = await read()
      if (!(sessionId in all)) return

      const { [sessionId]: _removed, ...rest } = all

      await write(rest)
    })
  }

  return { read, patch, dismiss, remove }
}
