import { z } from 'zod'

// The schema is the source of truth; types below derive via z.infer so they can't drift.
// How long a task has been untouched is intentionally absent: it's computed locally and joined
// back by index after the call, so the model can't hallucinate it.
//
// There is no priority: every task the model sees is one of at most TASKS_WIP_CAP commitments that
// have gone quiet, and a list that short is read in full rather than ranked. `habit` is absent for
// the same reason: a recurring practice never carries `#active`, so it can't reach the model.
export const classificationValues = ['aversion', 'blocked', 'conditional', 'fine'] as const

export const taskAnalysisSchema = z.object({
  // The task's position in the input list. The model echoes it so analyses join back to tasks
  // by index, which still works when the model paraphrases the title (a title match wouldn't).
  index: z.number().int(),
  title: z.string(),
  classification: z.enum(classificationValues),
  reasoning: z.string(),
  suggested_next_action: z.string().nullable(),
})

export const analysisResponseSchema = z.object({
  tasks: z.array(taskAnalysisSchema),
})

export type Classification = (typeof classificationValues)[number]
export type TaskAnalysis = z.infer<typeof taskAnalysisSchema>
