import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

const jsonValue = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid JSON' })

    return z.NEVER
  }
})

const schema = z.object({
  YNAB_TOKEN: z.string().min(1),
  YNAB_BUDGET_ID: z.uuid(),
  ALLOWED_ACCOUNT_IDS: jsonValue.pipe(z.record(z.string(), z.uuid())),
  // coerce to number because process.env values are always strings
  LOOKBACK_DAYS: z.coerce.number().pipe(z.int().positive()),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1),
  AUDIT_DIR: z.string().min(1),
  EXCLUDED_CATEGORY_GROUPS: jsonValue.pipe(z.array(z.string())),
  CATEGORY_ROUTING_HINTS: jsonValue.pipe(z.array(z.string())),
})

export type Config = {
  ynabToken: string
  budgetId: string
  /** categorize only PATCHes transactions whose `account_id` is in this set. */
  allowedAccountIds: Set<string>
  lookbackDays: number
  anthropicApiKey: string
  anthropicModel: string
  /** Created on first run if missing. Relative paths resolve from CWD. */
  auditDir: string
  /** Matched against `category_group_name` (case-sensitive). Groups in this set are dropped from the LLM prompt entirely, so the model never picks from them. */
  excludedCategoryGroups: Set<string>
  /** Free-form natural-language hints inserted as numbered rules in the LLM prompt — e.g. ``Pet items go to "Pet Care".`` */
  categoryRoutingHints: readonly string[]
}

export function loadConfig(): Config {
  const parsed = schema.parse(process.env)

  return {
    ynabToken: parsed.YNAB_TOKEN,
    budgetId: parsed.YNAB_BUDGET_ID,
    allowedAccountIds: new Set(Object.values(parsed.ALLOWED_ACCOUNT_IDS)),
    lookbackDays: parsed.LOOKBACK_DAYS,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicModel: parsed.ANTHROPIC_MODEL,
    auditDir: parsed.AUDIT_DIR,
    excludedCategoryGroups: new Set(parsed.EXCLUDED_CATEGORY_GROUPS),
    categoryRoutingHints: parsed.CATEGORY_ROUTING_HINTS,
  }
}
