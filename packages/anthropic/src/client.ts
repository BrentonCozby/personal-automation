import Anthropic, { AnthropicError } from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'

export { AnthropicError }

export type ParseResult<T> = {
  parsed: T | null
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export type AnthropicClient = {
  parse: <T>(params: {
    prompt: string
    schema: z.ZodType<T>
    maxTokens: number
  }) => Promise<ParseResult<T>>
}

/**
 * Sonnet 5 and later think whenever the request leaves `thinking` out, and `max_tokens` covers the
 * thinking and the answer together. A caller whose budget is sized for the answer alone asks for
 * this, or the reasoning eats the budget and the JSON is truncated past the point the schema parses.
 */
const THINKING_DISABLED = { type: 'disabled' } as const

export function createAnthropicClient({
  apiKey,
  model,
  maxRetries = 6,
  isThinkingDisabled = false,
}: {
  apiKey: string
  model: string
  /** Whether to ask for no thinking at all. Off leaves the model's own default in place. */
  isThinkingDisabled?: boolean
  /**
   * Cap on the SDK's automatic 429/5xx retries. Higher than the SDK default (2) so a bulk run
   * (e.g. a multi-day enrich backfill) can wait out the per-minute token rate limit instead of
   * failing once the default retries are spent.
   */
  maxRetries?: number
}): AnthropicClient {
  // The SDK retries 429/5xx with exponential backoff honoring the Retry-After header, so callers
  // don't wrap this in withRetry: non-retryable failures bubble up as AnthropicError.
  const client = new Anthropic({ apiKey, maxRetries })

  async function parse<T>({
    prompt,
    schema,
    maxTokens,
  }: {
    prompt: string
    schema: z.ZodType<T>
    maxTokens: number
  }): Promise<ParseResult<T>> {
    const start = Date.now()
    const response = await client.messages.parse({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: zodOutputFormat(schema) },
      ...(isThinkingDisabled ? { thinking: THINKING_DISABLED } : {}),
    })

    return {
      parsed: response.parsed_output ?? null,
      latencyMs: Date.now() - start,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }

  return { parse }
}
