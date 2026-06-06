import { appAuditDir } from '@personal-automation/common/audit-path'
import { jsonValue, loadAppEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadAppEnv(import.meta.url)

const schema = z.object({
  YNAB_TOKEN: z.string().min(1),
  YNAB_BUDGET_ID: z.uuid(),
  ALLOWED_ACCOUNT_IDS: jsonValue.pipe(z.record(z.string(), z.uuid())),
  ANTHROPIC_API_KEY: z.string().min(1),
  ENRICH_MEMOS_ANTHROPIC_MODEL: z.string().min(1),
  // coerce to number because process.env values are always strings
  ENRICH_LOOKBACK_DAYS: z.coerce.number().pipe(z.int().positive()),
  GMAIL_RECEIPT_WINDOW_DAYS: z.coerce.number().pipe(z.int().positive()),
  GMAIL_FROM_FILTER: jsonValue.pipe(z.array(z.string().min(1)).nonempty()),
  GMAIL_OAUTH_CLIENT_ID: z.string().min(1),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().min(1),
})

export type Config = {
  ynabToken: string
  budgetId: string
  /** Only transactions whose `account_id` is in this set are considered. */
  allowedAccountIds: Set<string>
  anthropicApiKey: string
  anthropicModel: string
  /** Absolute path to `apps/ynab-enrich-memos/audit`, resolved from this module (CWD-independent). Created on first run. */
  auditDir: string
  lookbackDays: number
  /** ± window (days) around a transaction's date to search for its receipt email. */
  receiptWindowDays: number
  /** Sender addresses Amazon receipts arrive from; OR-ed together in the Gmail query. */
  fromFilter: string[]
  gmailClientId: string
  gmailClientSecret: string
  gmailRefreshToken: string
}

export function loadConfig(): Config {
  const parsed = schema.parse(process.env)

  return {
    ynabToken: parsed.YNAB_TOKEN,
    budgetId: parsed.YNAB_BUDGET_ID,
    allowedAccountIds: new Set(Object.values(parsed.ALLOWED_ACCOUNT_IDS)),
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicModel: parsed.ENRICH_MEMOS_ANTHROPIC_MODEL,
    auditDir: appAuditDir(import.meta.url),
    lookbackDays: parsed.ENRICH_LOOKBACK_DAYS,
    receiptWindowDays: parsed.GMAIL_RECEIPT_WINDOW_DAYS,
    fromFilter: parsed.GMAIL_FROM_FILTER,
    gmailClientId: parsed.GMAIL_OAUTH_CLIENT_ID,
    gmailClientSecret: parsed.GMAIL_OAUTH_CLIENT_SECRET,
    gmailRefreshToken: parsed.GMAIL_OAUTH_REFRESH_TOKEN,
  }
}
