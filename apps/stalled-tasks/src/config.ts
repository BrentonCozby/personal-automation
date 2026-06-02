import { jsonValue, loadRootEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadRootEnv(import.meta.url)

export const weekdayValues = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const
export type Weekday = (typeof weekdayValues)[number]

const schema = z.object({
  STALLED_TASKS_TO_EMAIL: z.email(),
  DIGEST_DAY: z.enum(weekdayValues),
  // coerce because process.env values are always strings
  DIGEST_MAX_ITEMS: z.coerce.number().pipe(z.int().positive()),
  STALE_THRESHOLD_DAYS: z.coerce.number().pipe(z.int().positive()),
  REMINDERS_LISTS: jsonValue.pipe(z.array(z.string())),
  STALLED_TASKS_MODEL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  GMAIL_OAUTH_CLIENT_ID: z.string().min(1),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().min(1),
})

export type Config = {
  toEmail: string
  digestDay: Weekday
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
    digestDay: parsed.DIGEST_DAY,
    digestMaxItems: parsed.DIGEST_MAX_ITEMS,
    staleThresholdDays: parsed.STALE_THRESHOLD_DAYS,
    remindersLists: parsed.REMINDERS_LISTS,
    model: parsed.STALLED_TASKS_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    gmailClientId: parsed.GMAIL_OAUTH_CLIENT_ID,
    gmailClientSecret: parsed.GMAIL_OAUTH_CLIENT_SECRET,
    gmailRefreshToken: parsed.GMAIL_OAUTH_REFRESH_TOKEN,
  }
}
