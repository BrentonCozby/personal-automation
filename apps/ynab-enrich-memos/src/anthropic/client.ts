import {
  type AnthropicClient,
  AnthropicError,
  createAnthropicClient as createClient,
} from '@personal-automation/anthropic/client'
import { receiptResponseSchema } from './schemas.js'

export { AnthropicError }

// A receipt lists a handful of items with prices; 512 tokens covers the one-line summary with
// headroom so a multi-item order can't truncate mid-JSON (which would fail the schema parse).
const MAX_TOKENS = 512

export type ReceiptResult = {
  /** The item summary line, or null when no matching receipt was found. */
  summary: string | null
  /** The matched order's total, for verifying against the charge amount. Null when not found. */
  orderTotal: number | null
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
}

export type AnthropicEnrichClient = {
  extractReceipt: (params: { prompt: string }) => Promise<ReceiptResult>
}

export function createEnrichClient({
  apiKey,
  model,
}: {
  apiKey: string
  model: string
}): AnthropicEnrichClient {
  const client: AnthropicClient = createClient({ apiKey, model })

  async function extractReceipt({ prompt }: { prompt: string }): Promise<ReceiptResult> {
    const { parsed, latencyMs, inputTokens, outputTokens } = await client.parse({
      prompt,
      schema: receiptResponseSchema,
      maxTokens: MAX_TOKENS,
    })

    // Treat an empty summary as "not found" so a true return with a blank line can't slip
    // through to a memo of just the prefix.
    const found = parsed?.receipt_found === true
    const summary = found ? parsed.item_summary?.trim() || null : null
    const orderTotal = found ? (parsed.order_total ?? null) : null

    return { summary, orderTotal, latencyMs, inputTokens, outputTokens }
  }

  return { extractReceipt }
}
