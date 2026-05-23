import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

// Tight cap: Claude returns a few-token JSON object via structured outputs. 256 leaves
// generous headroom without inviting verbose preambles.
const MAX_TOKENS = 256

const categorizationSchema = z.object({
  category_id: z.string().optional(),
})

export type CategorizationResult = {
  categoryId: string | null
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
}

export type AnthropicCategorizeClient = {
  categorize: (params: { prompt: string }) => Promise<CategorizationResult>
}

type Init = { apiKey: string; model: string }

export function createAnthropicClient({ apiKey, model }: Init): AnthropicCategorizeClient {
  // SDK handles 429 / 5xx retry with exponential backoff internally (default 2 retries),
  // so we don't wrap this in withRetry — non-retryable errors bubble up to the per-txn
  // catch in categorize.ts and are recorded as audit `error` entries.
  const client = new Anthropic({ apiKey })

  async function categorize({ prompt }: { prompt: string }): Promise<CategorizationResult> {
    const start = Date.now()
    const response = await client.messages.parse({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: zodOutputFormat(categorizationSchema) },
    })

    const latencyMs = Date.now() - start
    return {
      categoryId: response.parsed_output?.category_id ?? null,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }

  return { categorize }
}
