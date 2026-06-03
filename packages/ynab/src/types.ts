import type { z } from 'zod'
import type { categoryGroupSchema, categorySchema, transactionSchema } from './schemas.js'

// Types are derived from zod schemas so a schema change can't silently drift from the type.

export type Category = z.infer<typeof categorySchema>
export type CategoryGroup = z.infer<typeof categoryGroupSchema>
export type Transaction = z.infer<typeof transactionSchema>

// TransactionPatch isn't validated from an API response (we send it), so it lives as a plain type.
// The bulk PATCH endpoint updates only the fields present on each patch and leaves the rest
// untouched, so every field but `id` is optional: ynab-categorize sends category + flag,
// ynab-enrich-memos sends memo alone.
export type TransactionPatch = {
  id: string
  category_id?: string
  flag_color?: string
  flag_name?: string
  memo?: string
}
