import { AppError, isRetryableHttpStatus } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import { GMAIL_REQUEST_TIMEOUT_MS, GOOGLE_OAUTH_TOKEN_URL } from './constants.js'
import { tokenResponseSchema } from './schemas.js'

export type GmailAuth = {
  getAccessToken: () => Promise<string>
}

type GmailAuthInit = {
  clientId: string
  clientSecret: string
  refreshToken: string
}

// Refresh the access token a minute before it actually expires so a request mid-flight
// can't hit a token that flipped to expired between cache-check and HTTP call.
const REFRESH_BUFFER_MS = 60_000

export function createGmailAuth({
  clientId,
  clientSecret,
  refreshToken,
}: GmailAuthInit): GmailAuth {
  let cache: { token: string; expiresAt: number } | null = null
  let inflight: Promise<string> | null = null

  function fetchFresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })

    return withRetry(async () => {
      const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(GMAIL_REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new AppError({
          message: `Google OAuth token refresh → ${res.status}: ${text}`,
          retryable: isRetryableHttpStatus(res.status),
        })
      }
      const parsed = tokenResponseSchema.parse(await res.json())
      cache = {
        token: parsed.access_token,
        expiresAt: Date.now() + parsed.expires_in * 1000,
      }

      return parsed.access_token
    })
  }

  function getAccessToken(): Promise<string> {
    if (cache && cache.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      return Promise.resolve(cache.token)
    }
    // Coalesce concurrent refresh calls so a burst of requests fires one refresh.
    if (inflight !== null) return inflight
    inflight = fetchFresh().finally(() => {
      inflight = null
    })

    return inflight
  }

  return { getAccessToken }
}
