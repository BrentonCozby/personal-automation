import { decodeEmailBodies } from '@personal-automation/common/test-mime'
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
    expect(decodeEmailBodies(decoded)).toContain('plain text body')
  })

  it('RFC 2047 encodes a non-ASCII subject and round-trips UTF-8 in the body', async (): Promise<void> => {
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
      // The apostrophe is U+2019, not ASCII. Keep a non-ASCII character in this subject or
      // the encoder short-circuits and this test silently stops covering the encoded-word path.
      subject: 'Personal Automation: today’s 3 errors',
      body: 'ynab-categorize: 3 errors\n═══════════════════════\n  Transaction abc',
    })

    const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
    // Body is base64 (charset utf-8); decoding it recovers the original UTF-8 glyphs.
    expect(decodeEmailBodies(decoded)).toContain('═══')
    // Subject is an encoded-word that round-trips back to the original text.
    const subjectLine = decoded.split('\r\n').find(l => l.startsWith('Subject: '))
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    const b64 = (subjectLine ?? '').replace('Subject: =?UTF-8?B?', '').replace('?=', '')
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(
      'Personal Automation: today’s 3 errors',
    )
  })

  it('leaves an ASCII subject unencoded', async (): Promise<void> => {
    let receivedRaw = ''
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        receivedRaw = ((await request.json()) as { raw: string }).raw

        return HttpResponse.json({ id: 'msg-1', threadId: 'thr-1' })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    await client.sendMessage({
      to: 'me@example.com',
      subject: 'Task Review - 5 flagged',
      body: 'b',
    })

    const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
    expect(decoded).toContain('Subject: Task Review - 5 flagged')
  })

  it('sends multipart/alternative with text + HTML parts when html is provided', async (): Promise<void> => {
    let receivedRaw = ''
    server.use(
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        receivedRaw = ((await request.json()) as { raw: string }).raw

        return HttpResponse.json({ id: 'msg-1', threadId: 'thr-1' })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    await client.sendMessage({
      to: 'me@example.com',
      subject: 'Hi',
      body: 'plain fallback',
      html: '<div>rich <strong>body</strong></div>',
    })

    const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
    expect(decoded).toContain('Content-Type: multipart/alternative; boundary="')
    expect(decoded).toContain('Content-Type: text/plain; charset="utf-8"')
    expect(decoded).toContain('Content-Type: text/html; charset="utf-8"')
    const bodies = decodeEmailBodies(decoded)
    expect(bodies).toContain('plain fallback')
    expect(bodies).toContain('<div>rich <strong>body</strong></div>')
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

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

describe('createGmailClient.listMessages', (): void => {
  it('passes the query + maxResults and returns the message refs', async (): Promise<void> => {
    let receivedUrl = ''
    let receivedAuth = ''
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, ({ request }) => {
        receivedUrl = request.url
        receivedAuth = request.headers.get('Authorization') ?? ''

        return HttpResponse.json({
          messages: [
            { id: 'm1', threadId: 't1' },
            { id: 'm2', threadId: 't2' },
          ],
          resultSizeEstimate: 2,
        })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const refs = await client.listMessages({
      query: 'from:amazon.com after:2026/05/01',
      maxResults: 5,
    })

    expect(refs).toEqual([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ])
    expect(receivedAuth).toBe('Bearer atok-test')
    const url = new URL(receivedUrl)
    expect(url.searchParams.get('q')).toBe('from:amazon.com after:2026/05/01')
    expect(url.searchParams.get('maxResults')).toBe('5')
  })

  it('returns an empty array when the query matches nothing (messages omitted)', async (): Promise<void> => {
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, () =>
        HttpResponse.json({ resultSizeEstimate: 0 }),
      ),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    expect(await client.listMessages({ query: 'from:nobody', maxResults: 5 })).toEqual([])
  })

  it('throws on a 4xx without retrying', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, () => {
        calls++

        return HttpResponse.text('bad query', { status: 400 })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    await expect(client.listMessages({ query: 'x', maxResults: 5 })).rejects.toThrow(/Gmail GET/)
    expect(calls).toBe(1)
  })
})

describe('createGmailClient.getMessage', (): void => {
  it('flattens the headers and decodes the text/plain part', async (): Promise<void> => {
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages/msg-1`, ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('format')).toBe('full')

        return HttpResponse.json({
          id: 'msg-1',
          threadId: 'thr-1',
          snippet: 'Your order of …',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'Subject', value: 'Your Amazon.com order' },
              { name: 'From', value: 'auto-confirm@amazon.com' },
              { name: 'Date', value: 'Mon, 25 May 2026 10:00:00 -0700' },
              {
                name: 'Authentication-Results',
                value: 'mx.google.com; dmarc=pass header.from=amazon.com',
              },
            ],
            body: { data: b64url('USB-C cable $12.99\nTotal $12.99'), size: 30 },
          },
        })
      }),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const msg = await client.getMessage({ id: 'msg-1' })

    expect(msg.id).toBe('msg-1')
    expect(msg.subject).toBe('Your Amazon.com order')
    expect(msg.from).toBe('auto-confirm@amazon.com')
    expect(msg.snippet).toBe('Your order of …')
    expect(msg.authenticationResults).toContain('dmarc=pass')
    expect(msg.bodyText).toBe('USB-C cable $12.99\nTotal $12.99')
  })

  it('walks nested multipart and prefers the text/plain part over HTML', async (): Promise<void> => {
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages/msg-2`, () =>
        HttpResponse.json({
          id: 'msg-2',
          threadId: 'thr-2',
          payload: {
            mimeType: 'multipart/alternative',
            headers: [{ name: 'Subject', value: 'Shipped' }],
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('plain wins') } },
              { mimeType: 'text/html', body: { data: b64url('<p>html loses</p>') } },
            ],
          },
        }),
      ),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const msg = await client.getMessage({ id: 'msg-2' })

    expect(msg.bodyText).toBe('plain wins')
  })

  it('falls back to HTML with tags + entities stripped when there is no plain part', async (): Promise<void> => {
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages/msg-3`, () =>
        HttpResponse.json({
          id: 'msg-3',
          threadId: 'thr-3',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'text/html',
                body: {
                  data: b64url(
                    '<style>.x{}</style><div>Tom &amp; Jerry cable&nbsp;&mdash; $5</div>',
                  ),
                },
              },
            ],
          },
        }),
      ),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const msg = await client.getMessage({ id: 'msg-3' })

    expect(msg.bodyText).toContain('Tom & Jerry cable')
    expect(msg.bodyText).not.toContain('<')
    expect(msg.bodyText).not.toContain('.x{}')
  })

  it('returns null headers and empty body when the payload is absent', async (): Promise<void> => {
    server.use(
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages/msg-4`, () =>
        HttpResponse.json({ id: 'msg-4', threadId: 'thr-4' }),
      ),
    )

    const client = createGmailClient({ auth: fakeAuth() })
    const msg = await client.getMessage({ id: 'msg-4' })

    expect(msg.subject).toBeNull()
    expect(msg.from).toBeNull()
    expect(msg.date).toBeNull()
    expect(msg.authenticationResults).toBeNull()
    expect(msg.bodyText).toBe('')
    expect(msg.snippet).toBe('')
  })
})
