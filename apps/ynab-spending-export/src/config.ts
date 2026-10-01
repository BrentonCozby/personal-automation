import { loadRootEnv } from '@personal-automation/common/env'
import { z } from 'zod'

loadRootEnv(import.meta.url)

const schema = z.object({
  YNAB_TOKEN: z.string().min(1),
  YNAB_BUDGET_ID: z.uuid(),
})

export type Config = { ynabToken: string; budgetId: string }

export function loadConfig(): Config {
  const parsed = schema.parse(process.env)

  return { ynabToken: parsed.YNAB_TOKEN, budgetId: parsed.YNAB_BUDGET_ID }
}
