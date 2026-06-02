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

export function createAnthropicClient({
  apiKey,
  model,
}: {
  apiKey: string
  model: string
}): AnthropicClient {
  // The SDK retries 429/5xx with exponential backoff internally (default 2 retries), so
  // callers don't wrap this in withRetry — non-retryable failures bubble up as AnthropicError.
  const client = new Anthropic({ apiKey })

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
