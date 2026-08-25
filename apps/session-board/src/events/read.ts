import { open, stat } from 'node:fs/promises'
import { parseEventLog } from './parse.js'
import type { ParsedEventLog } from './types.js'

const NEWLINE = 0x0a

export interface EventLogReader {
  /** Everything written so far. Also resets the tail position. */
  readAll(): Promise<ParsedEventLog>
  /** Only what has been appended since the last read. */
  readAppended(): Promise<ParsedEventLog>
}

async function readFrom({ path, offset }: { path: string; offset: number }): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= offset) return Buffer.alloc(0)

    const buffer = Buffer.alloc(size - offset)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)

    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export function createEventLogReader({ path }: { path: string }): EventLogReader {
  let offset = 0

  function readAll(): Promise<ParsedEventLog> {
    offset = 0

    return readAppended()
  }

  async function readAppended(): Promise<ParsedEventLog> {
    let size: number
    try {
      ;({ size } = await stat(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], skippedLineCount: 0 }
      }

      throw error
    }

    // The file shrank, so it was rotated or replaced. Anything held from the
    // old file describes bytes that are gone.
    if (size < offset) offset = 0

    const chunk = await readFrom({ path, offset })

    // Stop at the last newline and leave the rest for next time. A hook can be
    // mid-write, and a line without its newline yet would otherwise be read as
    // a damaged one. Measuring the cut in bytes rather than characters is what
    // keeps this honest: a multi-byte character split across the end of a write
    // decodes to a replacement character, whose own byte length differs, and
    // the offset would be wrong from then on for every read that follows.
    const lastNewline = chunk.lastIndexOf(NEWLINE)
    if (lastNewline === -1) return { events: [], skippedLineCount: 0 }

    offset += lastNewline + 1

    return parseEventLog(chunk.subarray(0, lastNewline).toString('utf8'))
  }

  return { readAll, readAppended }
}
