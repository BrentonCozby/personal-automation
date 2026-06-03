import { AppError, isRetryableHttpStatus } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import type { GmailAuth } from './auth.js'
import { GMAIL_API_BASE_URL } from './constants.js'
import {
  getMessageResponseSchema,
  listMessagesResponseSchema,
  sendMessageResponseSchema,
} from './schemas.js'
import type { GetMessageResponse, GmailMessage, MessageRef, SendMessageResponse } from './types.js'

// One node of a message's MIME tree. Reuses the shape the get-message schema validates so the
// decode helpers can't drift from what the parser accepts.
type MessagePart = NonNullable<GetMessageResponse['payload']>

type SendMessageParams = {
  to: string
  subject: string
  /** Plain-text body. Sent as text/plain, or as the fallback part when `html` is also given. */
  body: string
  /** Optional HTML body. When present the message is multipart/alternative (text + HTML). */
  html?: string
}

// Separates the parts of a multipart/alternative message. Must not occur in any part's content
// — this fixed string never appears in a digest.
const MULTIPART_BOUNDARY = 'personal-automation-alt-boundary-9d8f7a6b1c'

export type GmailClient = {
  sendMessage: (params: SendMessageParams) => Promise<SendMessageResponse>
  /** Search messages with a Gmail query string (the same syntax as the Gmail search box). */
  listMessages: (params: { query: string; maxResults: number }) => Promise<MessageRef[]>
  /** Fetch one message and normalize it — headers flattened, body decoded to text. */
  getMessage: (params: { id: string }) => Promise<GmailMessage>
}

export function createGmailClient({ auth }: { auth: GmailAuth }): GmailClient {
  // GET helper for the read endpoints. sendMessage keeps its own fetch — it POSTs a body and
  // pre-validates headers, so sharing this would tangle the two paths for little gain.
  function getJson<T>({
    path,
    schema,
  }: {
    path: string
    schema: { parse: (data: unknown) => T }
  }): Promise<T> {
    return withRetry(async () => {
      const token = await auth.getAccessToken()
      const res = await fetch(`${GMAIL_API_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const text = await res.text()
        throw new AppError({
          message: `Gmail GET ${path} → ${res.status}: ${text}`,
          retryable: isRetryableHttpStatus(res.status),
        })
      }

      return schema.parse(await res.json())
    })
  }

  function listMessages({
    query,
    maxResults,
  }: {
    query: string
    maxResults: number
  }): Promise<MessageRef[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })

    // `messages` is omitted (not an empty array) on a no-match query — collapse both to [].
    return getJson({
      path: `/users/me/messages?${params.toString()}`,
      schema: listMessagesResponseSchema,
    }).then(r => r.messages ?? [])
  }

  async function getMessage({ id }: { id: string }): Promise<GmailMessage> {
    const raw = await getJson({
      path: `/users/me/messages/${encodeURIComponent(id)}?format=full`,
      schema: getMessageResponseSchema,
    })

    return normalizeMessage(raw)
  }

  function sendMessage({
    to,
    subject,
    body,
    html,
  }: SendMessageParams): Promise<SendMessageResponse> {
    // Header values get interpolated into a multi-line RFC 5322 message — a CR or LF
    // in `to` or `subject` would let a caller inject extra headers (Bcc, etc.).
    // Use Promise.reject so the function consistently returns a Promise; a sync throw
    // would prevent callers from using `.rejects` / `.catch` chains.
    if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) {
      return Promise.reject(
        new AppError({
          message: 'Gmail sendMessage: `to` and `subject` must not contain CR or LF.',
        }),
      )
    }
    const raw = encodeRfc5322({ to, subject, body, ...(html !== undefined ? { html } : {}) })

    return withRetry(async () => {
      const token = await auth.getAccessToken()
      const res = await fetch(`${GMAIL_API_BASE_URL}/users/me/messages/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new AppError({
          message: `Gmail send → ${res.status}: ${text}`,
          retryable: isRetryableHttpStatus(res.status),
        })
      }

      return sendMessageResponseSchema.parse(await res.json())
    })
  }

  return { sendMessage, listMessages, getMessage }
}

function normalizeMessage(raw: GetMessageResponse): GmailMessage {
  const { payload } = raw

  return {
    id: raw.id,
    threadId: raw.threadId,
    snippet: raw.snippet ?? '',
    subject: headerValue({ payload, name: 'Subject' }),
    from: headerValue({ payload, name: 'From' }),
    date: headerValue({ payload, name: 'Date' }),
    authenticationResults: headerValue({ payload, name: 'Authentication-Results' }),
    bodyText: extractBodyText(payload),
  }
}

function headerValue({
  payload,
  name,
}: {
  payload: MessagePart | undefined
  name: string
}): string | null {
  const target = name.toLowerCase()
  const found = payload?.headers?.find(h => h.name.toLowerCase() === target)

  return found?.value ?? null
}

// Prefer the text/plain part; fall back to text/html with tags stripped. A receipt email is
// almost always multipart with both, so the plain part is the cheaper, cleaner input for the
// model. Returns '' when the message carries no textual part.
function extractBodyText(payload?: MessagePart): string {
  if (!payload) return ''
  const plain = collectText({ part: payload, mimeType: 'text/plain' }).trim()
  if (plain) return plain
  const html = collectText({ part: payload, mimeType: 'text/html' }).trim()
  if (html) return stripHtml(html)

  return ''
}

// Depth-first concatenation of every part matching `mimeType`. Gmail nests parts (e.g.
// multipart/alternative inside multipart/mixed), so this recurses rather than reading only
// the top-level body.
function collectText({ part, mimeType }: { part: MessagePart; mimeType: string }): string {
  let text =
    part.mimeType === mimeType && part.body?.data ? `${decodeBase64Url(part.body.data)}\n` : ''
  for (const child of part.parts ?? []) {
    text += collectText({ part: child, mimeType })
  }

  return text
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

// Minimal HTML-to-text: drop script/style blocks and tags, decode the handful of entities
// that show up in receipts, and collapse whitespace. Good enough to hand to the model — we
// don't need to preserve layout, just the words and prices.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Gmail's users.messages.send expects a base64url-encoded RFC 5322 message in the `raw` field.
// Charset is utf-8 so box-drawing chars and em dashes render. With `html`, the message is
// multipart/alternative: the text part first, then the HTML part (clients prefer the last
// part they can render, so HTML wins where supported and text is the fallback).
function encodeRfc5322({ to, subject, body, html }: SendMessageParams): string {
  const headers = [`To: ${to}`, `Subject: ${encodeSubjectHeader(subject)}`, 'MIME-Version: 1.0']

  const lines = html
    ? [
        ...headers,
        `Content-Type: multipart/alternative; boundary="${MULTIPART_BOUNDARY}"`,
        '',
        `--${MULTIPART_BOUNDARY}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        body,
        '',
        `--${MULTIPART_BOUNDARY}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        '',
        `--${MULTIPART_BOUNDARY}--`,
      ]
    : [
        ...headers,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        body,
      ]

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

// Email headers aren't covered by the body's Content-Type, so a raw UTF-8 character in the
// Subject (an em dash, box-drawing glyph, etc.) gets mis-decoded by mail clients and renders
// as mojibake like "Ã¢Â€Â"". RFC 2047 'encoded-word' carries it safely. ASCII subjects pass
// through unchanged. Digest subjects are short, so a single encoded-word stays within the
// 75-char limit — revisit with folding if subjects ever grow long.
function encodeSubjectHeader(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject

  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
}
