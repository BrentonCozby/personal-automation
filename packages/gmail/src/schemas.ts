import { z } from 'zod'

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
})

export const sendMessageResponseSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
})

export const messageRefSchema = z.object({
  id: z.string(),
  threadId: z.string(),
})

export const listMessagesResponseSchema = z.object({
  // Absent (not an empty array) when the query matches nothing.
  messages: z.array(messageRefSchema).optional(),
  resultSizeEstimate: z.number().optional(),
})

// A message's MIME tree. `body.data` is base64url-encoded; a multipart message carries its
// content in `parts` (recursively) rather than in its own `body`. Typed explicitly because the
// schema references itself through z.lazy and Zod can't infer a recursive type. Optional fields
// spell out `| undefined` to match Zod's `.optional()` output under exactOptionalPropertyTypes.
type MessagePart = {
  mimeType?: string | undefined
  headers?: { name: string; value: string }[] | undefined
  body?: { data?: string | undefined; size?: number | undefined } | undefined
  parts?: MessagePart[] | undefined
}

const messagePartSchema: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
    parts: z.array(messagePartSchema).optional(),
  }),
)

export const getMessageResponseSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().optional(),
  payload: messagePartSchema.optional(),
})
