import { setupMswServer } from '@personal-automation/common/test-msw'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { GmailAuth } from './auth.js'
import { createGmailClient } from './client.js'
import { GMAIL_API_BASE_URL } from './constants.js'

const server = setupMswServer()

function fakeAuth(): GmailAuth {
  return { getAccessToken: () => Promise.resolve('atok-test') }
}

describe('createGmailClient.sendMessage', (): void => {
  it('sends a base64url-encoded RFC 5322 message with the right headers', async (): Promise<void> => {
    let receivedRaw = ''
    let receivedAuth = ''
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        receivedAuth = request.headers.get('Authorization') ?? ''
        const body = (await request.json()) as { raw: string }
        receivedRaw = body.raw

        return HttpResponse.json({ id: 'msg-1', threadId: 'thr-1' })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const result = await client.sendMessage({
      to: 'me@example.com',
      subject: 'Hi',
      body: 'plain text body',
    })

    expect(result).toEqual({ id: 'msg-1', threadId: 'thr-1' })
    expect(receivedAuth).toBe('Bearer atok-test')

    const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
    expect(decoded).toContain('To: me@example.com')
    expect(decoded).toContain('Subject: Hi')
    expect(decoded).toContain('Content-Type: text/plain; charset="utf-8"')
    expect(decoded).toContain('plain text body')
  })

  it('preserves non-ASCII chars (box-drawing) through base64url', async (): Promise<void> => {
    let receivedRaw = ''
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        const body = (await request.json()) as { raw: string }
        receivedRaw = body.raw

        return HttpResponse.json({ id: 'msg-1', threadId: 'thr-1' })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    await client.sendMessage({
      to: 'me@example.com',
      subject: 'YNAB Automation — 3 errors',
      body: 'ynab-categorize — 3 errors\n═══════════════════════\n  Transaction abc',
    })

    const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
    expect(decoded).toContain('═══')
    expect(decoded).toContain('Subject: YNAB Automation — 3 errors')
  })

  it('throws on 4xx and does not retry (client error)', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, () => {
        calls++

        return HttpResponse.text('forbidden', { status: 403 })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    await expect(
      client.sendMessage({ to: 'me@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/Gmail send → 403/)
    expect(calls).toBe(1)
  })

  it('retries on 503 and eventually succeeds', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, () => {
        calls++
        if (calls < 2) return HttpResponse.text('unavailable', { status: 503 })

        return HttpResponse.json({ id: 'msg-2', threadId: 'thr-2' })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const result = await client.sendMessage({ to: 'me@example.com', subject: 's', body: 'b' })

    expect(result).toEqual({ id: 'msg-2', threadId: 'thr-2' })
    expect(calls).toBe(2)
  })

  it('rejects CR/LF in `to` to prevent header injection', async (): Promise<void> => {
    const client = createGmailClient({ auth: fakeAuth() })
    await expect(
      client.sendMessage({
        to: 'me@example.com\r\nBcc: attacker@evil.com',
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/must not contain CR or LF/)
  })

  it('rejects CR/LF in `subject` to prevent header injection', async (): Promise<void> => {
    const client = createGmailClient({ auth: fakeAuth() })
    await expect(
      client.sendMessage({
        to: 'me@example.com',
        subject: 'hi\nBcc: attacker@evil.com',
        body: 'b',
      }),
    ).rejects.toThrow(/must not contain CR or LF/)
  })

  it('throws on response shape mismatch (zod validation)', async (): Promise<void> => {
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, () =>
        HttpResponse.json({ wrong: 'shape' }),
      ),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    await expect(
      client.sendMessage({ to: 'me@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow()
  })
})
