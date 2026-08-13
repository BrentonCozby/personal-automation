import { z } from 'zod'

/**
 * Pushover's reply to an accepted message. `status: 1` is the only success it sends; a refusal
 * arrives as a 4xx carrying an `errors` array, which the client turns into a failure before this
 * parses anything.
 */
export const pushoverResponseSchema = z.object({
  status: z.literal(1),
  request: z.string().min(1),
})

export type PushoverResponse = z.infer<typeof pushoverResponseSchema>
