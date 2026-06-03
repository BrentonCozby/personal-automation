import type { z } from 'zod'
import type {
  getMessageResponseSchema,
  messageRefSchema,
  sendMessageResponseSchema,
} from './schemas.js'

export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>

/** A bare {id, threadId} pointer returned by a list/search query. */
export type MessageRef = z.infer<typeof messageRefSchema>

/** Raw shape of a `users.messages.get` response, before `getMessage` normalizes it. */
export type GetMessageResponse = z.infer<typeof getMessageResponseSchema>

/**
 * A message after `getMessage` normalizes it: the headers we care about are flattened to
 * fields and the MIME tree is decoded to a single `bodyText`. Callers never touch the raw
 * base64url payload.
 */
export type GmailMessage = {
  id: string
  threadId: string
  snippet: string
  subject: string | null
  from: string | null
  date: string | null
  /**
   * The `Authentication-Results` header Gmail stamps on received mail (its SPF/DKIM/DMARC
   * verdict), or null if absent. Lets callers gate on sender authenticity.
   */
  authenticationResults: string | null
  /** Decoded body: the text/plain part if present, otherwise text/html with tags stripped. */
  bodyText: string
}
