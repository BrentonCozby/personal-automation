import { loadAppEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadAppEnv(import.meta.url)

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
  /** Runs inside the new tab. `{{id}}` becomes the session id. */
  launchCommand: string
  /** Runs when a progress-file slug is clicked. `{{path}}` becomes the file. */
  openFileCommand: string
  /**
   * Starts a fresh named session, for both of the ways the board makes one:
   * resuming a row that has a progress file, and the `+` on a group header.
   *
   * `{{name}}` and `{{prompt}}` are substituted, both shell-quoted. `{{prompt}}`
   * drops out of the command when there is nothing to say, which is what a
   * session started from a group header with a brand new progress file gets.
   */
  progressCommand: string
  /** The first thing that new session is told. `{{progress}}` becomes the file. */
  progressPrompt: string
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
    transcriptRoots: parsed.BOARD_TRANSCRIPT_ROOTS.split(',')
      .map(root => root.trim())
      .filter(Boolean),
  }
}
