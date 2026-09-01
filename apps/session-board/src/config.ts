import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadAppEnv(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))

// Both defaults live here rather than in .env, which git does not track: they
// are the same text on every machine, and a board restored from an older .env
// has to keep working rather than exit on a missing variable.
// Names the CLAUDE.md rule it overrides and whose instruction it is. Measured:
// a note that only said the option was off lost to that rule, and the session
// said it would write the file anyway for a task spanning several sittings.
const NO_PROGRESS_NOTE =
  "The user unchecked the board's progress-file option when starting this session. That is their instruction for this session, and it overrides the standing CLAUDE.md rule about keeping a `*.progress.local.md` file for multi-sitting work. Do not create one, however long the task runs. If you think this task needs one, ask before writing it."
const NEW_PROGRESS_NOTE =
  'The board created a progress file for this work at {{progress}}. Fill it in at the first milestone and keep it current, and do not start a second one.'

const schema = z.object({
  BOARD_EVENT_LOG: z.string().min(1),
  BOARD_METADATA_FILE: z.string().min(1),
  BOARD_GROUPS_FILE: z.string().min(1),
  BOARD_PORT: z.coerce.number().pipe(z.int().positive()),
  BOARD_STALE_DAYS: z.coerce.number().pipe(z.int().positive()),
  BOARD_FRESH_MINUTES: z.coerce.number().pipe(z.int().positive()),
  BOARD_LAUNCH_COMMAND: z.string().min(1),
  BOARD_OPEN_FILE_COMMAND: z.string().min(1),
  BOARD_TRANSCRIPT_ROOTS: z.string().min(1),
  BOARD_PROGRESS_COMMAND: z.string().min(1),
  BOARD_PROGRESS_PROMPT: z.string().min(1),
  BOARD_NO_PROGRESS_NOTE: z.string().min(1).default(NO_PROGRESS_NOTE),
  BOARD_NEW_PROGRESS_NOTE: z.string().min(1).default(NEW_PROGRESS_NOTE),
})

export interface Config {
  /** The append-only log the Claude Code hooks write. The board only ever reads it. */
  eventLogPath: string
  /** Your annotations. The server is the only writer; no hook touches it. */
  metadataPath: string
  /** The groups that exist, so one holding no sessions is still drawn. */
  groupsPath: string
  port: number
  /** Days of silence after which a row's age is called out. */
  staleDays: number
  /** Minutes within which a finished session still reads as "your move" rather than muted. */
  freshMinutes: number
  /**
   * Runs inside the new tab. `{{id}}` becomes the session id and `{{system}}`
   * the appended system prompt file, that one inserted as it stands rather than
   * quoted, because Ghostty quotes the whole command again. A template missing
   * `{{system}}` is refused.
   */
  launchCommand: string
  /** Runs when a progress-file slug is clicked. `{{path}}` becomes the file. */
  openFileCommand: string
  /**
   * Starts a fresh named session, for both of the ways the board makes one:
   * resuming a row that has a progress file, and the `+` on a group header.
   *
   * `{{name}}`, `{{prompt}}` and `{{system}}` are substituted, all shell-quoted.
   * `{{prompt}}` drops out of the command when there is nothing to say, which is
   * what a session started from a group header with a brand new progress file
   * gets. `{{system}}` never drops out, so a template missing it is refused.
   */
  progressCommand: string
  /** The first thing that new session is told. `{{progress}}` becomes the file. */
  progressPrompt: string
  /**
   * Read and appended to the system prompt of every session the board starts.
   *
   * A file beside the source rather than a configured path: it ships with the
   * app, so a machine-specific absolute path would only be a way to get it
   * wrong.
   */
  subagentGrantPath: string
  /** Appended when the start panel's progress-file checkbox was unchecked. */
  noProgressNote: string
  /**
   * Appended when the progress file did not exist until this launch. That
   * session gets no first prompt, so this is the only thing that names the file
   * to it. `{{progress}}` becomes the file.
   */
  newProgressNote: string
  /**
   * The `projects` directories Claude Code keeps transcripts under. A session
   * with no transcript in any of them cannot be resumed at all.
   */
  transcriptRoots: string[]
}

export function loadConfig(): Config {
  const parsed = schema.parse(process.env)

  return {
    eventLogPath: parsed.BOARD_EVENT_LOG,
    metadataPath: parsed.BOARD_METADATA_FILE,
    groupsPath: parsed.BOARD_GROUPS_FILE,
    port: parsed.BOARD_PORT,
    staleDays: parsed.BOARD_STALE_DAYS,
    freshMinutes: parsed.BOARD_FRESH_MINUTES,
    launchCommand: parsed.BOARD_LAUNCH_COMMAND,
    openFileCommand: parsed.BOARD_OPEN_FILE_COMMAND,
    progressCommand: parsed.BOARD_PROGRESS_COMMAND,
    progressPrompt: parsed.BOARD_PROGRESS_PROMPT,
    // `src` when tsx runs the source and `dist` when tsc has built it, and the
    // file sits one level above either.
    subagentGrantPath: join(HERE, '..', 'subagent-grant.md'),
    noProgressNote: parsed.BOARD_NO_PROGRESS_NOTE,
    newProgressNote: parsed.BOARD_NEW_PROGRESS_NOTE,
    transcriptRoots: parsed.BOARD_TRANSCRIPT_ROOTS.split(',')
      .map(root => root.trim())
      .filter(Boolean),
  }
}
