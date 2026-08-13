import { jsonValue, loadAppEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadAppEnv(import.meta.url)

// TASKS_SCHEDULE (the days/times the digest runs) isn't here: it's consumed only by the
// launchd plist generator at setup time, not at app runtime. launchd fires the digest on the
// scheduled days/times, so the app has no day-gate of its own: when invoked, it reviews.
const schema = z.object({
  TASKS_TO_EMAIL: z.email(),
  // The thresholds of the state model. They live here and nowhere else, so no part of the
  // app can hold its own idea of how many days or how many commitments are too many. Coerced
  // because process.env values are always strings.
  TASKS_WIP_CAP: z.coerce.number().pipe(z.int().positive()),
  TASKS_STALL_DAYS: z.coerce.number().pipe(z.int().positive()),
  TASKS_HORIZON_DAYS: z.coerce.number().pipe(z.int().positive()),
  TASKS_DONE_WINDOW_DAYS: z.coerce.number().pipe(z.int().positive()),
  TASKS_OVERRIDE_WINDOW_DAYS: z.coerce.number().pipe(z.int().positive()),
  // Zero is allowed: it asks for the suggestion the first time the cap is raised at all.
  TASKS_OVERRIDE_LIMIT: z.coerce.number().pipe(z.int().nonnegative()),
  TASK_LISTS: jsonValue.pipe(z.array(z.string())),
  OBSIDIAN_VAULT_PATH: z.string().min(1),
  TASKS_ANTHROPIC_MODEL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  GMAIL_OAUTH_CLIENT_ID: z.string().min(1),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().min(1),
})

export type Config = {
  toEmail: string
  /** How many tasks may carry `#active` at once. Promotion past it needs `--over-cap`. */
  wipCap: number
  /** Days an `#active` task can go untouched before it counts as stalled. */
  stallDays: number
  /**
   * How far ahead a date can honestly be seen. The decay threshold and the scheduling ceiling are
   * the same number because they are the same claim: a date past it is routed to `#someday`.
   */
  horizonDays: number
  /**
   * How many days of finished and dropped tasks the done list covers, counting today. A separate
   * claim from the stall window: one is how long silence is tolerable, this is how far back a record
   * of what you did stays interesting.
   */
  doneWindowDays: number
  /** How many days of raised caps the review looks back over before judging the cap too low. */
  overrideWindowDays: number
  /**
   * Raises inside that window the cap is allowed before the review suggests raising it for good.
   * A cap gone around exactly this many times is a cap that mostly holds.
   */
  overrideLimit: number
  /** Files or folders in the vault that hold tasks; empty = just `todos.md` at the vault root. */
  taskLists: string[]
  /** The vault folder every command reads and writes. */
  obsidianVaultPath: string
  model: string
  anthropicApiKey: string
  gmailClientId: string
  gmailClientSecret: string
  gmailRefreshToken: string
}

export function loadConfig(): Config {
  const parsed = schema.parse(process.env)

  return {
    toEmail: parsed.TASKS_TO_EMAIL,
    wipCap: parsed.TASKS_WIP_CAP,
    stallDays: parsed.TASKS_STALL_DAYS,
    horizonDays: parsed.TASKS_HORIZON_DAYS,
    doneWindowDays: parsed.TASKS_DONE_WINDOW_DAYS,
    overrideWindowDays: parsed.TASKS_OVERRIDE_WINDOW_DAYS,
    overrideLimit: parsed.TASKS_OVERRIDE_LIMIT,
    taskLists: parsed.TASK_LISTS,
    obsidianVaultPath: parsed.OBSIDIAN_VAULT_PATH,
    model: parsed.TASKS_ANTHROPIC_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    gmailClientId: parsed.GMAIL_OAUTH_CLIENT_ID,
    gmailClientSecret: parsed.GMAIL_OAUTH_CLIENT_SECRET,
    gmailRefreshToken: parsed.GMAIL_OAUTH_REFRESH_TOKEN,
  }
}
