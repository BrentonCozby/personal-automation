import { z } from 'zod'

// The schema is the source of truth; types below derive via z.infer so they can't drift.
// stale_days is intentionally absent — it's computed locally and joined back by index after
// the call, so the model can't hallucinate it.
export const classificationValues = ['aversion', 'blocked', 'conditional', 'habit', 'fine'] as const
export const priorityValues = ['low', 'medium', 'high'] as const

export const taskAnalysisSchema = z.object({
  // The task's position in the input list. The model echoes it so analyses join back to tasks
  // by index — robust to the model paraphrasing the title (which would break a title match).
  index: z.number().int(),
  title: z.string(),
  classification: z.enum(classificationValues),
  reasoning: z.string(),
  suggested_next_action: z.string().nullable(),
  priority: z.enum(priorityValues),
})

export const analysisResponseSchema = z.object({
  tasks: z.array(taskAnalysisSchema),
})

export type Classification = (typeof classificationValues)[number]
export type Priority = (typeof priorityValues)[number]
export type TaskAnalysis = z.infer<typeof taskAnalysisSchema>
