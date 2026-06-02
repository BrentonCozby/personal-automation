import {
  type AnthropicClient,
  AnthropicError,
  createAnthropicClient as createClient,
} from '@personal-automation/anthropic/client'
import { analysisResponseSchema, type TaskAnalysis } from './schemas.js'

export { AnthropicError }

// Each task's analysis (reasoning + next action + enums) runs ~80-150 output tokens. Budget
// generously per task with a floor and a hard ceiling so a large list can't get truncated
// mid-JSON (which would fail the schema parse) and a tiny list still has room.
const TOKENS_PER_TASK = 256
const MIN_TOKENS = 1024
const MAX_TOKENS = 16_384

export function maxTokensForTasks(taskCount: number): number {
  return Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, MIN_TOKENS + taskCount * TOKENS_PER_TASK))
}

export type AnalyzeResult = {
  analyses: TaskAnalysis[]
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

export type StalledTasksAnalyzer = {
  analyze: (params: { prompt: string; taskCount: number }) => Promise<AnalyzeResult>
}

export function createAnalyzer({
  apiKey,
  model,
}: {
  apiKey: string
  model: string
}): StalledTasksAnalyzer {
  const client: AnthropicClient = createClient({ apiKey, model })

  async function analyze({
    prompt,
    taskCount,
  }: {
    prompt: string
    taskCount: number
  }): Promise<AnalyzeResult> {
    const { parsed, latencyMs, inputTokens, outputTokens } = await client.parse({
      prompt,
      schema: analysisResponseSchema,
      maxTokens: maxTokensForTasks(taskCount),
    })

    return {
      analyses: parsed?.tasks ?? [],
      latencyMs,
      inputTokens,
      outputTokens,
    }
  }

  return { analyze }
}
