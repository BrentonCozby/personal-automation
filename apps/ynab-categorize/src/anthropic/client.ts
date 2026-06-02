import {
  type AnthropicClient,
  AnthropicError,
  createAnthropicClient as createClient,
} from '@personal-automation/anthropic/client'
import { z } from 'zod'

export { AnthropicError }

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

export function createAnthropicClient({
  apiKey,
  model,
}: {
  apiKey: string
  model: string
}): AnthropicCategorizeClient {
  const client: AnthropicClient = createClient({ apiKey, model })

  async function categorize({ prompt }: { prompt: string }): Promise<CategorizationResult> {
    const { parsed, latencyMs, inputTokens, outputTokens } = await client.parse({
      prompt,
      schema: categorizationSchema,
      maxTokens: MAX_TOKENS,
    })

    return {
      categoryId: parsed?.category_id ?? null,
      latencyMs,
      inputTokens,
      outputTokens,
    }
  }

  return { categorize }
}
