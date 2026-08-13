import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { createGmailAuth } from './auth.js'
import { GOOGLE_OAUTH_TOKEN_URL } from './constants.js'

const server = setupMswServer()

function makeAuth(): ReturnType<typeof createGmailAuth> {
  return createGmailAuth({
    clientId: 'cid',
    clientSecret: 'secret',
    refreshToken: 'rtok',
  })
}

describe('createGmailAuth.getAccessToken', (): void => {
  it('exchanges the refresh token for an access token', async (): Promise<void> => {
    let receivedBody = ''
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
        receivedBody = await request.text()

        return HttpResponse.json({
          access_token: 'atok-123',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }),
    )

    const token = await makeAuth().getAccessToken()

    expect(token).toBe('atok-123')
    const params = new URLSearchParams(receivedBody)
    expect(params.get('client_id')).toBe('cid')
    expect(params.get('client_secret')).toBe('secret')
    expect(params.get('refresh_token')).toBe('rtok')
    expect(params.get('grant_type')).toBe('refresh_token')
  })

  it('caches the access token across calls', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () => {
        calls++

        return HttpResponse.json({
          access_token: 'atok-cached',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }),
    )

    const auth = makeAuth()
    const t1 = await auth.getAccessToken()
    const t2 = await auth.getAccessToken()

    expect(t1).toBe('atok-cached')
    expect(t2).toBe('atok-cached')
    expect(calls).toBe(1)
  })

  it('coalesces concurrent refreshes into one HTTP call', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async () => {
        calls++
        await new Promise(r => setTimeout(r, 30))

        return HttpResponse.json({
          access_token: 'atok-coalesced',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }),
    )

    const auth = makeAuth()
    const [t1, t2, t3] = await Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
    ])

    expect([t1, t2, t3]).toEqual(['atok-coalesced', 'atok-coalesced', 'atok-coalesced'])
    expect(calls).toBe(1)
  })

  it('refreshes again when the cached token is near expiry', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () => {
        calls++

        return HttpResponse.json({
          access_token: `atok-${calls}`,
          // 30 seconds, under the 60-second refresh buffer so the second call refreshes.
          expires_in: 30,
          token_type: 'Bearer',
        })
      }),
    )

    const auth = makeAuth()
    const t1 = await auth.getAccessToken()
    const t2 = await auth.getAccessToken()

    expect(t1).toBe('atok-1')
    expect(t2).toBe('atok-2')
    expect(calls).toBe(2)
  })

  it('throws on a 4xx from Google (non-retryable)', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () => {
        calls++

        return HttpResponse.text('invalid_client', { status: 400 })
      }),
    )

    await expect(makeAuth().getAccessToken()).rejects.toThrow(/Google OAuth token refresh → 400/)
    expect(calls).toBe(1)
  })

  it('throws an actionable re-auth error on invalid_grant (non-retryable)', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () => {
        calls++

        return HttpResponse.text(
          '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
          { status: 400 },
        )
      }),
    )

    const err = await makeAuth()
      .getAccessToken()
      .catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/invalid_grant/)
    expect((err as Error).message).toMatch(/bootstrap/)
    expect(calls).toBe(1)
  })

  it('retries on 500 and eventually succeeds', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () => {
        calls++
        if (calls < 2) return HttpResponse.text('boom', { status: 500 })

        return HttpResponse.json({
          access_token: 'atok-after-retry',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }),
    )

    const token = await makeAuth().getAccessToken()

    expect(token).toBe('atok-after-retry')
    expect(calls).toBe(2)
  })
})
