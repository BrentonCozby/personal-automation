import type { z } from 'zod'
import type { sendMessageResponseSchema } from './schemas.js'

export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>
