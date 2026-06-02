import { AppError, isRetryableHttpStatus } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import type { GmailAuth } from './auth.js'
import { GMAIL_API_BASE_URL } from './constants.js'
import { sendMessageResponseSchema } from './schemas.js'
import type { SendMessageResponse } from './types.js'

type SendMessageParams = {
  to: string
  subject: string
  body: string
}

export type GmailClient = {
  sendMessage: (params: SendMessageParams) => Promise<SendMessageResponse>
}

export function createGmailClient({ auth }: { auth: GmailAuth }): GmailClient {
  function sendMessage({ to, subject, body }: SendMessageParams): Promise<SendMessageResponse> {
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
    const raw = encodeRfc5322({ to, subject, body })

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

// Gmail's users.messages.send expects a base64url-encoded RFC 5322 message in the `raw`
// field. Charset must be utf-8 so the box-drawing chars in the digest render correctly.
function encodeRfc5322({ to, subject, body }: SendMessageParams): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ]
  const message = lines.join('\r\n')

  return Buffer.from(message, 'utf8').toString('base64url')
}
