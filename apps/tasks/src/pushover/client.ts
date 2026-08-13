import { AppError, isRetryableHttpStatus } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import { pushoverResponseSchema } from './schemas.js'

const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json'
const REQUEST_TIMEOUT_MS = 10_000
// Normal priority: one banner, one sound, no repeat. Two passes a day are the redundancy, and a
// task ticked in Obsidian drops off the next pass on its own.
const PRIORITY = '0'

export type PushoverMessage = {
  title: string
  message: string
  /** Opened when the notification is tapped. Custom schemes (obsidian://) are allowed. */
  url: string
  urlTitle: string
}

export type PushoverClient = {
  send: (message: PushoverMessage) => Promise<{ requestId: string }>
}

/**
 * Pushover, the channel the due-date alerts go out on.
 *
 * A refusal throws rather than being logged and swallowed. A meds alert that vanishes quietly is
 * the worst outcome this job has, so the run exits non-zero and the launchd wrapper posts a macOS
 * notification about it.
 */
export function createPushoverClient({
  token,
  userKey,
}: {
  token: string
  userKey: string
}): PushoverClient {
  async function send({
    title,
    message,
    url,
    urlTitle,
  }: PushoverMessage): Promise<{ requestId: string }> {
    return await withRetry(async () => {
      const res = await fetch(PUSHOVER_MESSAGES_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token,
          user: userKey,
          title,
          message,
          url,
          url_title: urlTitle,
          priority: PRIORITY,
        }),
      })
      if (!res.ok) {
        throw new AppError({
          message: `Pushover refused the alert: ${res.status} ${await res.text()}`,
          retryable: isRetryableHttpStatus(res.status),
        })
      }

      return { requestId: pushoverResponseSchema.parse(await res.json()).request }
    })
  }

  return { send }
}
