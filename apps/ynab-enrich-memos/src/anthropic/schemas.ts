import { z } from 'zod'

// Structured output, so the response is a typed object rather than a free-text sentinel:
// `receipt_found` is the discriminator, `item_summary` carries the one-line summary, and
// `order_total` is the matched order's total — returned separately so the caller can verify it
// against the charge amount deterministically. All non-found fields are null.
export const receiptResponseSchema = z.object({
  receipt_found: z.boolean(),
  item_summary: z.string().nullable(),
  order_total: z.number().nullable(),
})

export type ReceiptResponse = z.infer<typeof receiptResponseSchema>
