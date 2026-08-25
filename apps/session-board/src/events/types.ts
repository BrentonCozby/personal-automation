import type { z } from 'zod'
import type { hookEventSchema } from './schemas.js'

export type HookEvent = z.infer<typeof hookEventSchema>

export interface ParsedEventLog {
  events: HookEvent[]
  skippedLineCount: number
}
