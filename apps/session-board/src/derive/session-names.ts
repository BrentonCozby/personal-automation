import { type FileHandle, open } from 'node:fs/promises'
import { z } from 'zod'
import type { HookEvent } from '../events/types.js'
import { toKebabCase, withoutWindowNumber } from '../session-name.js'

/**
 * How much of a transcript is read looking for a name.
 *
 * Both things worth reading sit at the front: Claude Code writes the title
 * within the first few records, and the first prompt is by definition the first
 * one. A transcript can reach tens of megabytes after a long session, and
 * reading one whole per row would cost more than the whole snapshot.
 */
const PREFIX_BYTES = 128 * 1024

/** Words a name worked out from a prompt is cut to, so a row stays one line. */
const MAX_PROMPT_WORDS = 4

/**
 * The names Claude Code reported for itself, keyed by session.
 *
 * Both the name you passed to `claude -n` and the title Claude Code writes for
 * you arrive in `session_title`, so this is every session that has ever called
 * itself anything. The last one wins: renaming a session emits the new title
 * and leaves the old one in the log forever.
 */
export function findEventTitles({ events }: { events: HookEvent[] }): Map<string, string> {
  const titles = new Map<string, string>()

  for (const event of events) {
    if (!event.session_title) continue

    // Kept out of the name: read as part of it, `technical-interview-round (2)`
    // kebab-cases into a second row for the same job, linked to the same
    // progress file as the first.
    const name = toKebabCase(withoutWindowNumber(event.session_title))
    if (!name) continue

    titles.set(event.session_id, name)
  }

  return titles
}

/** Every path a session has reported a transcript at, newest report first. */
export function findTranscriptPaths({ events }: { events: HookEvent[] }): Map<string, string[]> {
  const paths = new Map<string, string[]>()

  for (const event of events) {
    if (!event.transcript_path) continue

    const known = paths.get(event.session_id) ?? []

    // A session written under two project roots reports both. The later report
    // is the one still being written to, so it is tried first.
    paths.set(event.session_id, [
      event.transcript_path,
      ...known.filter(path => path !== event.transcript_path),
    ])
  }

  return paths
}

/**
 * The first few words of a prompt, as a name.
 *
 * Undefined when there was nothing usable in it, which a caller reads as having
 * no name to offer rather than as an empty one.
 */
export function nameFromPrompt(prompt: string): string | undefined {
  const name = toKebabCase(prompt).split('-').slice(0, MAX_PROMPT_WORDS).join('-')

  return name || undefined
}

// Claude Code's own file, so the board reads the two records it needs and lets
// every other field and record type through untouched. `content` is a string on
// a plain turn and a list of blocks once a turn carries anything else.
const transcriptRecordSchema = z.object({
  type: z.string().optional(),
  customTitle: z.string().optional(),
  isSidechain: z.boolean().optional(),
  message: z
    .object({
      content: z.union([
        z.string(),
        // Both fields optional: a `tool_result` block carries no `text`, and a
        // required one would fail the whole record rather than this one block,
        // throwing away the `customTitle` sitting on it.
        z.array(z.object({ type: z.string().optional(), text: z.string().optional() })),
      ]),
    })
    .optional()
    // A message shape Claude Code adds later means no prompt to read here, not
    // a record worth dropping.
    .catch(undefined),
})

type TranscriptRecord = z.infer<typeof transcriptRecordSchema>

function parseRecord(line: string): TranscriptRecord | undefined {
  try {
    const parsed = transcriptRecordSchema.safeParse(JSON.parse(line))

    return parsed.success ? parsed.data : undefined
  } catch {
    // The last line of a prefix read is usually cut in half, and a transcript
    // being appended to while it is read can hand back a partial line anywhere.
    return undefined
  }
}

/**
 * What a person typed in this turn, or undefined when they typed nothing.
 *
 * A `user` record is not the same thing as a prompt. Tool results come back as
 * user turns, a subagent's whole conversation is written into the transcript of
 * the session that spawned it, and Claude Code writes its own markup (`/clear`,
 * command names, caveats) into user records too. All three would otherwise name
 * the row, and the markup ones would name most of them the same thing.
 */
function promptIn(record: TranscriptRecord): string | undefined {
  if (record.type !== 'user' || record.isSidechain === true) return undefined

  const content = record.message?.content
  if (content === undefined) return undefined

  // `text` blocks only. A turn carrying a tool result is a user record too, and
  // joining its blocks in would name the row after whatever a command printed.
  const text =
    typeof content === 'string'
      ? content
      : content
          .flatMap(block => (block.type === 'text' && block.text ? [block.text] : []))
          .join(' ')

  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('<')) return undefined

  return trimmed
}

async function openTranscript(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r')
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    // A transcript for an account that is gone, or one deleted since the event
    // that named it.
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') return undefined

    throw error
  }
}

async function readPrefix(path: string): Promise<string | undefined> {
  const handle = await openTranscript(path)
  if (!handle) return undefined

  try {
    const buffer = Buffer.alloc(PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0)

    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function nameFromTranscript(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const prefix = await readPrefix(path)
    if (prefix === undefined) continue

    let firstPrompt: string | undefined
    for (const line of prefix.split('\n')) {
      if (!line) continue

      const record = parseRecord(line)
      if (!record) continue

      // The title outranks the prompt wherever both exist: Claude Code wrote it
      // to say what the session is about, which is the whole question here.
      if (record.type === 'custom-title' && record.customTitle) {
        const title = toKebabCase(record.customTitle)
        if (title) return title
      }

      if (firstPrompt === undefined) firstPrompt = promptIn(record)
    }

    if (firstPrompt !== undefined) return nameFromPrompt(firstPrompt)
  }

  return undefined
}

export interface DerivableSession {
  sessionId: string
  /** Every path the session has reported a transcript at, newest report first. */
  transcriptPaths: string[]
  /** What the session reported calling itself, from `findEventTitles`. */
  title?: string | undefined
}

export interface SessionNamer {
  /**
   * A name for each session that could be named, worked out from the session
   * itself. A session with nothing to go on is left out rather than given an
   * empty name.
   */
  derive(input: { sessions: DerivableSession[] }): Promise<Map<string, string>>
}

/**
 * Names for sessions you never named yourself, read out of their transcripts.
 *
 * A factory rather than a plain function because of the cache: the first prompt
 * of a session never changes, so a transcript is worth reading once and never
 * again. Without it every snapshot would re-read one file per unnamed row,
 * every thirty seconds, forever.
 */
export function createSessionNamer(): SessionNamer {
  const named = new Map<string, string>()

  async function derive({
    sessions,
  }: {
    sessions: DerivableSession[]
  }): Promise<Map<string, string>> {
    const answers = new Map<string, string>()

    await Promise.all(
      sessions.map(async ({ sessionId, transcriptPaths, title }) => {
        // A title the session reported is already in memory and always current,
        // so it outranks the transcript and is never cached: renaming a session
        // emits a new one, and a remembered answer would outlive the old name.
        // It is also the only name left for a session whose transcript is gone.
        if (title) {
          answers.set(sessionId, title)

          return
        }

        const remembered = named.get(sessionId)
        if (remembered !== undefined) {
          answers.set(sessionId, remembered)

          return
        }

        const name = await nameFromTranscript(transcriptPaths)
        // A miss is not remembered. A session that has started but not yet been
        // asked anything has a transcript with no prompt in it, and caching
        // that would leave its row unnamed for as long as the board runs.
        if (name === undefined) return

        named.set(sessionId, name)
        answers.set(sessionId, name)
      }),
    )

    return answers
  }

  return { derive }
}
