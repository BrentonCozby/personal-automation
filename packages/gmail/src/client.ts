import { AppError, isRetryableHttpStatus } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import type { GmailAuth } from './auth.js'
import { GMAIL_API_BASE_URL } from './constants.js'
import { sendMessageResponseSchema } from './schemas.js'
import type { SendMessageResponse } from './types.js'

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
}

export function createGmailClient({ auth }: { auth: GmailAuth }): GmailClient {
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

  return { sendMessage }
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
