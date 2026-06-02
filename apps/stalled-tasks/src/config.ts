import { jsonValue, loadRootEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadRootEnv(import.meta.url)

// STALLED_TASKS_SCHEDULE (the days/times the digest runs) isn't here: it's consumed only by the
// launchd plist generator at setup time, not at app runtime. launchd fires the digest on the
// scheduled days/times, so the app has no day-gate of its own — when invoked, it runs and sends.
const schema = z.object({
  STALLED_TASKS_TO_EMAIL: z.email(),
  // coerce because process.env values are always strings
  DIGEST_MAX_ITEMS: z.coerce.number().pipe(z.int().positive()),
  STALE_THRESHOLD_DAYS: z.coerce.number().pipe(z.int().positive()),
  REMINDERS_LISTS: jsonValue.pipe(z.array(z.string())),
  STALLED_TASKS_ANTHROPIC_MODEL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  GMAIL_OAUTH_CLIENT_ID: z.string().min(1),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().min(1),
})

export type Config = {
  toEmail: string
  digestMaxItems: number
  staleThresholdDays: number
  /** Reminders lists to read; empty = all lists. */
  remindersLists: string[]
  model: string
  anthropicApiKey: string
  gmailClientId: string
  gmailClientSecret: string
  gmailRefreshToken: string
}

export function loadConfig(): Config {
  const parsed = schema.parse(process.env)

  return {
    toEmail: parsed.STALLED_TASKS_TO_EMAIL,
    digestMaxItems: parsed.DIGEST_MAX_ITEMS,
    staleThresholdDays: parsed.STALE_THRESHOLD_DAYS,
    remindersLists: parsed.REMINDERS_LISTS,
    model: parsed.STALLED_TASKS_ANTHROPIC_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    gmailClientId: parsed.GMAIL_OAUTH_CLIENT_ID,
    gmailClientSecret: parsed.GMAIL_OAUTH_CLIENT_SECRET,
    gmailRefreshToken: parsed.GMAIL_OAUTH_REFRESH_TOKEN,
  }
}
