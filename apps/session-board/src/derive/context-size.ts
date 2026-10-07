import { type FileHandle, open } from 'node:fs/promises'
import { z } from 'zod'
import type { Transcript } from './transcripts.js'

/** How much of a transcript is read at a time, working back from its end. */
const CHUNK_BYTES = 256 * 1024

const NEWLINE = 0x0a

// An API error is written as an assistant message from this model with every
// usage count at zero, which would read as an empty context.
const SYNTHETIC_MODEL = '<synthetic>'

// Claude Code's own file, so only the fields read here are checked.
const assistantRecordSchema = z.object({
  type: z.literal('assistant'),
  isSidechain: z.boolean().optional(),
  message: z.object({
    model: z.string().optional(),
    usage: z.object({
      input_tokens: z.number(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    }),
  }),
})

/**
 * The tokens the line's turn sent to the model, or undefined when the line is
 * not the main conversation's assistant turn.
 */
function contextTokensIn(line: string): number | undefined {
  // Most lines are tool results and prompts, and parsing each would cost more
  // than the read.
  if (!line.includes('"assistant"')) return undefined

  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (error) {
    // A transcript being appended to while it is read can end in half a line.
    if (error instanceof SyntaxError) return undefined

    throw error
  }

  const parsed = assistantRecordSchema.safeParse(json)
  if (!parsed.success) return undefined

  const { isSidechain, message } = parsed.data
  // A subagent's turns measure the subagent's context, not this session's.
  if (isSidechain || message.model === SYNTHETIC_MODEL) return undefined

  const { usage } = message

  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  )
}

async function openTranscript(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r')
  } catch (error) {
    // Deleted between the listing and the read.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined

    throw error
  }
}

/**
 * Reads back from the end one chunk at a time, so the cost is the distance
 * from the last assistant turn to the end of the file rather than the file.
 */
async function readLastContextTokens({
  path,
  size,
}: {
  path: string
  size: number
}): Promise<number | undefined> {
  const handle = await openTranscript(path)
  if (!handle) return undefined

  try {
    // The pieces, in file order, of the line the previous chunks began partway
    // through. Kept apart and joined once, since one line can be megabytes long.
    let tail: Buffer[] = []
    let end = size

    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)

      let lineEnd = chunk.length

      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== NEWLINE) continue

        const line = Buffer.concat([chunk.subarray(index + 1, lineEnd), ...tail])
        tail = []
        const tokens = contextTokensIn(line.toString('utf8'))
        if (tokens !== undefined) return tokens

        lineEnd = index
      }

      tail = [chunk.subarray(0, lineEnd), ...tail]
      end = start
    }

    return contextTokensIn(Buffer.concat(tail).toString('utf8'))
  } finally {
    await handle.close()
  }
}

export interface ContextReader {
  /**
   * What each session's most recent assistant turn sent to the model, in
   * tokens. A session with no assistant turn yet is left out.
   */
  read(input: { transcripts: Map<string, Transcript> }): Promise<Map<string, number>>
}

/**
 * Context sizes read out of the session transcripts.
 *
 * A factory for the cache: a transcript can be tens of megabytes and the board
 * rebuilds every ten seconds, so a file is read again only once its size or
 * write time has moved.
 */
export function createContextReader(): ContextReader {
  let cache = new Map<string, { size: number; modifiedMs: number; tokens: number | undefined }>()

  async function read({
    transcripts,
  }: {
    transcripts: Map<string, Transcript>
  }): Promise<Map<string, number>> {
    const next: typeof cache = new Map()
    const answers = new Map<string, number>()

    await Promise.all(
      [...transcripts].map(async ([sessionId, { path, size, modifiedMs }]) => {
        const cached = cache.get(path)
        const tokens =
          cached?.size === size && cached.modifiedMs === modifiedMs
            ? cached.tokens
            : await readLastContextTokens({ path, size })

        next.set(path, { size, modifiedMs, tokens })
        if (tokens !== undefined) answers.set(sessionId, tokens)
      }),
    )

    // Rebuilt rather than added to, so a transcript that is gone or no longer
    // asked about is dropped.
    cache = next

    return answers
  }

  return { read }
}
