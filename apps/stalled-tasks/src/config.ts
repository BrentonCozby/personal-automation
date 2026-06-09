import { jsonValue, loadAppEnv } from '@personal-automation/common/env'
import { z } from 'zod'
import { TASK_PROVIDERS, type TaskProvider } from './tasks/source.js'

loadAppEnv(import.meta.url)

// STALLED_TASKS_SCHEDULE (the days/times the digest runs) isn't here: it's consumed only by the
// launchd plist generator at setup time, not at app runtime. launchd fires the digest on the
// scheduled days/times, so the app has no day-gate of its own — when invoked, it runs and sends.
const schema = z.object({
  STALLED_TASKS_TO_EMAIL: z.email(),
  // coerce because process.env values are always strings
  DIGEST_MAX_ITEMS: z.coerce.number().pipe(z.int().positive()),
  STALE_THRESHOLD_DAYS: z.coerce.number().pipe(z.int().positive()),
  // Which backend to read tasks from. Selecting a provider is a config change, not a code one.
  TASK_PROVIDER: z.enum(TASK_PROVIDERS),
  TASK_LISTS: jsonValue.pipe(z.array(z.string())),
  // Provider-specific: only used (and required) when TASK_PROVIDER=obsidian — validated at the
  // seam in createTaskSource, so other providers don't have to set it. Optional here, not a
  // .default(), so the repo's no-default rule holds.
  OBSIDIAN_VAULT_PATH: z.string().min(1).optional(),
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
  /** Which task backend to read from. */
  taskProvider: TaskProvider
  /** Task lists to read; empty = just todos.md. */
  taskLists: string[]
  /** Vault folder for the obsidian provider; undefined for other providers. */
  obsidianVaultPath?: string
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
    taskProvider: parsed.TASK_PROVIDER,
    taskLists: parsed.TASK_LISTS,
    // Spread rather than assign undefined: exactOptionalPropertyTypes rejects `key: undefined`.
    ...(parsed.OBSIDIAN_VAULT_PATH !== undefined
      ? { obsidianVaultPath: parsed.OBSIDIAN_VAULT_PATH }
      : {}),
    model: parsed.STALLED_TASKS_ANTHROPIC_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    gmailClientId: parsed.GMAIL_OAUTH_CLIENT_ID,
    gmailClientSecret: parsed.GMAIL_OAUTH_CLIENT_SECRET,
    gmailRefreshToken: parsed.GMAIL_OAUTH_REFRESH_TOKEN,
  }
}
