import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createAnthropicClient } from './client.js'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const server = setupMswServer()

// Anthropic Messages API response shape — the SDK parses content[0].text against the
// Zod schema in output_config.format and surfaces it as parsed_output.
function anthropicResponse(content: string): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  }
}

it('parses the model output against the given schema and returns usage + latency', async (): Promise<void> => {
  server.use(
    http.post(MESSAGES_URL, () =>
      HttpResponse.json(anthropicResponse('{"sentiment":"positive","score":0.9}')),
    ),
  )
  const client = createAnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5' })
  const schema = z.object({ sentiment: z.string(), score: z.number() })

  const result = await client.parse({ prompt: 'classify this', schema, maxTokens: 64 })

  expect(result.parsed).toEqual({ sentiment: 'positive', score: 0.9 })
  expect(result.inputTokens).toBe(100)
  expect(result.outputTokens).toBe(20)
  expect(result.latencyMs).toBeGreaterThanOrEqual(0)
})

it('forwards the model, max_tokens, and prompt to the Messages API', async (): Promise<void> => {
  let captured: unknown
  server.use(
    http.post(MESSAGES_URL, async ({ request }) => {
      captured = await request.json()

      return HttpResponse.json(anthropicResponse('{"ok":true}'))
    }),
  )
  const client = createAnthropicClient({ apiKey: 'test-key', model: 'claude-sonnet-5' })

  await client.parse({ prompt: 'hello', schema: z.object({ ok: z.boolean() }), maxTokens: 128 })

  const body = z
    .object({
      model: z.string(),
      max_tokens: z.number(),
      messages: z.array(z.object({ role: z.string(), content: z.string() })),
    })
    .parse(captured)
  expect(body.model).toBe('claude-sonnet-5')
  expect(body.max_tokens).toBe(128)
  expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
})

// Sonnet 5 and later think unless told not to, and the thinking shares the max_tokens ceiling with
// the answer. A caller whose budget is sized for the answer alone has to be able to turn it off.
it('asks for no thinking only when the caller says so', async (): Promise<void> => {
  const bodies: unknown[] = []
  server.use(
    http.post(MESSAGES_URL, async ({ request }) => {
      bodies.push(await request.json())

      return HttpResponse.json(anthropicResponse('{"ok":true}'))
    }),
  )
  const call = { prompt: 'hello', schema: z.object({ ok: z.boolean() }), maxTokens: 128 }

  await createAnthropicClient({ apiKey: 'test-key', model: 'claude-sonnet-5' }).parse(call)
  await createAnthropicClient({
    apiKey: 'test-key',
    model: 'claude-sonnet-5',
    isThinkingDisabled: true,
  }).parse(call)

  const bodySchema = z.object({ thinking: z.object({ type: z.string() }).optional() })
  expect(bodySchema.parse(bodies[0]).thinking).toBeUndefined()
  expect(bodySchema.parse(bodies[1]).thinking).toEqual({ type: 'disabled' })
})
