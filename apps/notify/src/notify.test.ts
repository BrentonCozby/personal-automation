import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { GMAIL_API_BASE_URL, GOOGLE_OAUTH_TOKEN_URL } from '@personal-automation/gmail/constants'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Config } from './config.js'
import { runNotify } from './notify.js'

const server = setupMswServer()

const TODAY = '2026-05-28'

function makeConfig(): Config {
  return {
    toEmail: 'me@example.com',
    gmailClientId: 'cid',
    gmailClientSecret: 'secret',
    gmailRefreshToken: 'rtok',
  }
}

function setupAppsDir(): string {
  return mkdtempSync(join(tmpdir(), 'notify-test-'))
}

function writeJsonl({
  appsDir,
  app,
  rows,
  date = TODAY,
}: {
  appsDir: string
  app: string
  rows: Record<string, unknown>[]
  date?: string
}): void {
  const auditDir = join(appsDir, app, 'audit')
  mkdirSync(auditDir, { recursive: true })
  const content = `${rows.map(r => JSON.stringify(r)).join('\n')}\n`
  writeFileSync(join(auditDir, `${app}-${date}.jsonl`), content)
}

function baseRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: '2026-05-28T12:00:00Z',
    transaction_id: 't-default',
    payee_name: 'Amazon',
    memo: null,
    amount_dollars: -42.1,
    patch_status: 'success',
    ...overrides,
  }
}

describe('runNotify', (): void => {
  it('returns no_errors and skips send when today’s audit logs have no error rows', async (): Promise<void> => {
    const appsDir = setupAppsDir()
    writeJsonl({
      appsDir,
      app: 'ynab-categorize',
      rows: [
        baseRow({ transaction_id: 'a', patch_status: 'success' }),
        baseRow({ transaction_id: 'b', patch_status: 'success' }),
      ],
    })

    const result = await runNotify({ config: makeConfig(), today: TODAY, appsDir })

    expect(result).toEqual({ kind: 'no_errors', rowsRead: 2 })
  })

  it('sends a digest via Gmail (full HTTP path with msw) when error rows are present', async (): Promise<void> => {
    const appsDir = setupAppsDir()
    writeJsonl({
      appsDir,
      app: 'ynab-categorize',
      rows: [
        baseRow({ transaction_id: 'good', patch_status: 'success' }),
        baseRow({
          transaction_id: 'bad',
          patch_status: 'error',
          error: 'rate_limit_error: 429 from anthropic',
        }),
      ],
    })

    let receivedAuth = ''
    let receivedRaw = ''
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () =>
        HttpResponse.json({
          access_token: 'atok-from-msw',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      ),
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        receivedAuth = request.headers.get('Authorization') ?? ''
        const body = (await request.json()) as { raw: string }
        receivedRaw = body.raw

        return HttpResponse.json({ id: 'msg-xyz', threadId: 'thr-xyz' })
      }),
    )

    const result = await runNotify({ config: makeConfig(), today: TODAY, appsDir })

    expect(result).toEqual({ kind: 'sent', errorCount: 1, messageId: 'msg-xyz' })
    expect(receivedAuth).toBe('Bearer atok-from-msw')

    const decoded = Buffer.from(receivedRaw, 'base64url').toString('utf8')
    expect(decoded).toContain('To: me@example.com')
    expect(decoded).toContain('Subject: YNAB Automation — 1 error')
    expect(decoded).toContain('Transaction bad')
    expect(decoded).toContain('rate_limit_error: 429 from anthropic')
  })

  it('skips malformed JSONL lines and still reads valid ones', async (): Promise<void> => {
    const appsDir = setupAppsDir()
    const auditDir = join(appsDir, 'ynab-categorize', 'audit')
    mkdirSync(auditDir, { recursive: true })
    const content = [
      JSON.stringify(baseRow({ transaction_id: 'good-1', patch_status: 'success' })),
      '{not valid json',
      JSON.stringify({ missing_required_fields: true }),
      JSON.stringify(baseRow({ transaction_id: 'good-2', patch_status: 'error', error: 'boom' })),
      '',
    ].join('\n')
    writeFileSync(join(auditDir, `ynab-categorize-${TODAY}.jsonl`), content)

    let sentSubject = ''
    let receivedRaw = ''
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () =>
        HttpResponse.json({
          access_token: 'atok',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      ),
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        const body = (await request.json()) as { raw: string }
        receivedRaw = body.raw
        const decoded = Buffer.from(body.raw, 'base64url').toString('utf8')
        sentSubject = decoded.split('\r\n').find(l => l.startsWith('Subject: ')) ?? ''

        return HttpResponse.json({ id: 'msg-1', threadId: 'thr-1' })
      }),
    )

    const result = await runNotify({ config: makeConfig(), today: TODAY, appsDir })

    expect(result.kind).toBe('sent')
    expect(sentSubject).toBe('Subject: YNAB Automation — 1 error')
    expect(receivedRaw).not.toBe('')
  })

  it('ignores apps with no audit dir and date-stamped files for other dates', async (): Promise<void> => {
    const appsDir = setupAppsDir()
    // App with audit dir but yesterday's file.
    writeJsonl({
      appsDir,
      app: 'ynab-categorize',
      rows: [baseRow({ transaction_id: 'old', patch_status: 'error', error: 'old-boom' })],
      date: '2026-05-27',
    })
    // App with today's file.
    writeJsonl({
      appsDir,
      app: 'ynab-enrich-memos',
      rows: [
        baseRow({
          transaction_id: 'fresh',
          patch_status: 'error',
          error: 'fresh-boom',
        }),
      ],
    })
    // App with no audit dir at all.
    mkdirSync(join(appsDir, 'lonely-app'), { recursive: true })

    let receivedBody = ''
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, () =>
        HttpResponse.json({ access_token: 'a', expires_in: 3600, token_type: 'Bearer' }),
      ),
      http.post(`${GMAIL_API_BASE_URL}/users/me/messages/send`, async ({ request }) => {
        const body = (await request.json()) as { raw: string }
        receivedBody = Buffer.from(body.raw, 'base64url').toString('utf8')

        return HttpResponse.json({ id: 'msg-1', threadId: 'thr-1' })
      }),
    )

    const result = await runNotify({ config: makeConfig(), today: TODAY, appsDir })

    expect(result).toEqual({ kind: 'sent', errorCount: 1, messageId: 'msg-1' })
    expect(receivedBody).toContain('fresh-boom')
    expect(receivedBody).not.toContain('old-boom')
  })

  it('skips a notify-named audit file if one ever appears (self-feed guard)', async (): Promise<void> => {
    const appsDir = setupAppsDir()
    writeJsonl({
      appsDir,
      app: 'notify',
      rows: [
        baseRow({
          transaction_id: 'self',
          patch_status: 'error',
          error: 'should-not-loop',
        }),
      ],
    })

    const result = await runNotify({ config: makeConfig(), today: TODAY, appsDir })

    expect(result).toEqual({ kind: 'no_errors', rowsRead: 0 })
  })

  it('returns no_errors when the apps dir does not exist', async (): Promise<void> => {
    const appsDir = join(tmpdir(), 'notify-nonexistent-dir', `${Date.now()}`)

    const result = await runNotify({ config: makeConfig(), today: TODAY, appsDir })

    expect(result).toEqual({ kind: 'no_errors', rowsRead: 0 })
  })
})
