import { z } from 'zod'

// Structured output, so the response is a typed object rather than a free-text sentinel:
// `receipt_found` is the discriminator, `item_summary` carries the one-line summary,
// `order_total` is the matched order's total — returned separately so the caller can verify it
// against the charge amount deterministically — and `matched_email_index` points back at the
// source email so the caller can link to it. All non-found fields are null.
export const receiptResponseSchema = z.object({
  receipt_found: z.boolean(),
  item_summary: z.string().nullable(),
  order_total: z.number().nullable(),
  /**
   * The `index` (shown on each email in the prompt) of the one email the summary came from, or
   * null when no receipt matched. Lets the caller link the audit row back to the source email.
   */
  matched_email_index: z.number().int().nullable(),
})

export type ReceiptResponse = z.infer<typeof receiptResponseSchema>
