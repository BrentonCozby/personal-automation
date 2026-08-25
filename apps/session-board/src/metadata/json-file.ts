import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ZodType } from 'zod'

export interface JsonFile<T> {
  read(): Promise<T>
  write(value: T): Promise<void>
  /** Run mutations one at a time, since each is a read, a merge and a write. */
  serialize<R>(work: () => Promise<R>): Promise<R>
}

/**
 * A small JSON file the board owns, read and written whole.
 *
 * `empty` is what a file that does not exist yet reads as.
 */
export function createJsonFile<T>({
  path,
  schema,
  empty,
}: {
  path: string
  schema: ZodType<T>
  empty: T
}): JsonFile<T> {
  let writeCount = 0
  let queue: Promise<unknown> = Promise.resolve()

  /**
   * Two mutations overlapping lose one of the two edits, and both racing on the
   * same temporary file produced a file that was one object followed by the
   * tail of a longer one. Rejections are swallowed from the queue only, so the
   * caller still sees its own error and one failure does not wedge every later
   * write.
   */
  function serialize<R>(work: () => Promise<R>): Promise<R> {
    const result = queue.then(work, work)
    queue = result.catch(() => undefined)

    return result
  }

  async function read(): Promise<T> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty

      throw error
    }

    // A damaged file is thrown rather than treated as empty. Starting from
    // empty would look like a working board with no sessions on it, and the
    // next edit would write that emptiness back over the real annotations.
    return schema.parse(JSON.parse(text))
  }

  async function write(value: T): Promise<void> {
    await mkdir(dirname(path), { recursive: true })

    // Write beside the target and rename over it. rename is atomic within a
    // filesystem, so a crash mid-write leaves the previous file intact instead
    // of a half-written one. The counter keeps two writes from sharing a
    // temporary file and interleaving their bytes into it.
    writeCount += 1
    const temporaryPath = `${path}.${process.pid}.${writeCount}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  return { read, write, serialize }
}
