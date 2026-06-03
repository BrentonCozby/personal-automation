import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUN_ABORTED_SENTINEL } from '@personal-automation/common/logger'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { GMAIL_API_BASE_URL, GOOGLE_OAUTH_TOKEN_URL } from '@personal-automation/gmail/constants'
import { YNAB_API_BASE_URL } from '@personal-automation/ynab/constants'
import { HttpResponse, http, type RequestHandler } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from './config.js'
import { type EnrichMemosAudit, runEnrich } from './enrich.js'

const BUDGET_ID = '11111111-1111-1111-1111-111111111111'
const ACCOUNT_ID = 'acct-A'
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const SUMMARY = 'USB-C cable ($12.99), AA batteries ($8.49) — Total $21.48'

const server = setupMswServer()

let auditDir: string

beforeEach((): void => {
  auditDir = mkdtempSync(join(tmpdir(), 'enrich-e2e-'))
})

afterEach((): void => {
  rmSync(auditDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ynabToken: 'test-token',
    budgetId: BUDGET_ID,
    allowedAccountIds: new Set([ACCOUNT_ID]),
    anthropicApiKey: 'test-anthropic-key',
    anthropicModel: 'claude-haiku-4-5',
    auditDir,
    lookbackDays: 5,
    receiptWindowDays: 5,
    fromFilter: ['auto-confirm@amazon.com'],
    gmailClientId: 'cid',
    gmailClientSecret: 'secret',
    gmailRefreshToken: 'rtok',
    ...overrides,
  }
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function makeTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'txn-1',
    account_id: ACCOUNT_ID,
    date: '2026-05-20',
    payee_name: 'Amazon',
    memo: null,
    amount: -21_480,
    transfer_account_id: null,
    transfer_transaction_id: null,
    flag_name: null,
    flag_color: null,
    category_id: null,
    ...overrides,
  }
}

// The SDK parses content[0].text against the zod schema and surfaces it as parsed_output.
function anthropicResponse(obj: unknown): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 300, output_tokens: 40 },
  }
}

function oauthHandler(): RequestHandler {
  return http.post(GOOGLE_OAUTH_TOKEN_URL, () =>
    HttpResponse.json({ access_token: 'atok', expires_in: 3600, token_type: 'Bearer' }),
  )
}

function transactionsHandler(transactions: Record<string, unknown>[]): RequestHandler {
  return http.get(
    `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
    () => HttpResponse.json({ data: { transactions } }),
  )
}

function gmailReceiptHandlers(): RequestHandler[] {
  return [
    http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, () =>
      HttpResponse.json({ messages: [{ id: 'm1', threadId: 'thr-1' }], resultSizeEstimate: 1 }),
    ),
    http.get(`${GMAIL_API_BASE_URL}/users/me/messages/:id`, () =>
      HttpResponse.json({
        id: 'm1',
        threadId: 'thr-1',
        snippet: 'Your Amazon.com order',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Subject', value: 'Your Amazon.com order' },
            { name: 'From', value: 'auto-confirm@amazon.com' },
            {
              name: 'Authentication-Results',
              value:
                'mx.google.com; spf=pass; dkim=pass header.d=amazon.com; dmarc=pass header.from=amazon.com',
            },
          ],
          body: { data: b64url('USB-C cable $12.99\nAA batteries $8.49\nOrder total $21.48') },
        },
      }),
    ),
  ]
}

function readAuditLines(): EnrichMemosAudit[] {
  const lines: EnrichMemosAudit[] = []
  for (const f of readdirSync(auditDir)) {
    for (const line of readFileSync(join(auditDir, f), 'utf8').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as EnrichMemosAudit)
    }
  }

  return lines
}

describe('runEnrich (e2e)', (): void => {
  it('happy path: finds the receipt, PATCHes a prefixed memo, writes an ok audit row', async (): Promise<void> => {
    type PatchBody = { transactions?: { id: string; memo?: string }[] }
    let patchedBody: PatchBody | null = null
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      ...gmailReceiptHandlers(),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(
          anthropicResponse({ receipt_found: true, item_summary: SUMMARY, order_total: 21.48 }),
        ),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, async ({ request }) => {
        patchedBody = (await request.json()) as PatchBody

        return HttpResponse.json({ data: { transaction_ids: ['txn-1'] } })
      }),
    )

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 1, failed: 0, skipped: 0 })

    const patched = (patchedBody as PatchBody | null)?.transactions
    expect(patched).toHaveLength(1)
    expect(patched?.[0]?.id).toBe('txn-1')
    expect(patched?.[0]?.memo).toBe(`auto-gen: ${SUMMARY}`)

    const audit = readAuditLines()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.app).toBe('ynab-enrich-memos')
    expect(audit[0]?.status).toBe('ok')
    expect(audit[0]?.patch_status).toBe('success')
    expect(audit[0]?.new_memo).toBe(`auto-gen: ${SUMMARY}`)
    expect(audit[0]?.emails_found).toBe(1)
  })

  it('no matching email: leaves the memo, audits no_emails, never calls the model', async (): Promise<void> => {
    let llmCalled = false
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, () =>
        HttpResponse.json({ resultSizeEstimate: 0 }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () => {
        llmCalled = true

        return HttpResponse.json(
          anthropicResponse({ receipt_found: false, item_summary: null, order_total: null }),
        )
      }),
    )

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(llmCalled).toBe(false)
    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 1 })
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('no_emails')
    expect(audit[0]?.patch_status).toBe('skipped_for_no_match')
  })

  it('emails found but no receipt matches: audits no_receipt, no PATCH', async (): Promise<void> => {
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      ...gmailReceiptHandlers(),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(
          anthropicResponse({ receipt_found: false, item_summary: null, order_total: null }),
        ),
      ),
    )

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 1 })
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('no_receipt')
    expect(audit[0]?.patch_status).toBe('skipped_for_no_match')
    expect(audit[0]?.emails_found).toBe(1)
  })

  it('rejects a confident match whose order total does not match the charge (amount guard)', async (): Promise<void> => {
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      ...gmailReceiptHandlers(),
      // The model returns a confident match, but for the wrong order ($99.99 vs the $21.48 charge).
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(
          anthropicResponse({
            receipt_found: true,
            item_summary: 'Some unrelated order — Total $99.99',
            order_total: 99.99,
          }),
        ),
      ),
      // No PATCH handler: a write would be an unhandled request and fail the test.
    )

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 1 })
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('no_receipt')
    expect(audit[0]?.patch_status).toBe('skipped_for_no_match')
    expect(audit[0]?.new_memo).toBeNull()
  })

  it('dry-run: builds the memo but does not PATCH, audits skipped_for_dry_run', async (): Promise<void> => {
    let patchCalled = false
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      ...gmailReceiptHandlers(),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(
          anthropicResponse({ receipt_found: true, item_summary: SUMMARY, order_total: 21.48 }),
        ),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, () => {
        patchCalled = true

        return HttpResponse.json({ data: { transaction_ids: [] } })
      }),
    )

    const result = await runEnrich({ config: makeConfig(), opts: { dryRun: true, verbose: false } })

    expect(patchCalled).toBe(false)
    expect(result.succeeded).toBe(1)
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('ok')
    expect(audit[0]?.patch_status).toBe('skipped_for_dry_run')
    expect(audit[0]?.new_memo).toBe(`auto-gen: ${SUMMARY}`)
  })

  it('skips rows that already have a memo, with no Gmail or model calls', async (): Promise<void> => {
    // Only the YNAB transactions GET is registered. Any Gmail/OAuth/Anthropic call would hit an
    // unhandled request and fail the test via msw's onUnhandledRequest: 'error'.
    server.use(transactionsHandler([makeTxn({ memo: 'gift for mom — do not touch' })]))

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 0 })
    expect(readAuditLines()).toHaveLength(0)
  })

  it('drops a DMARC-failing candidate (forged sender) and records untrusted_dropped, no model call', async (): Promise<void> => {
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, () =>
        HttpResponse.json({ messages: [{ id: 'm1', threadId: 'thr-1' }], resultSizeEstimate: 1 }),
      ),
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages/:id`, () =>
        HttpResponse.json({
          id: 'm1',
          threadId: 'thr-1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'Subject', value: 'Your Amazon.com order' },
              {
                name: 'Authentication-Results',
                value: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail header.from=amazon.com',
              },
            ],
            body: { data: b64url('forged receipt total $21.48') },
          },
        }),
      ),
      // No Anthropic handler: with the only candidate dropped, a model call would be an
      // unhandled request and fail the test.
    )

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 1 })
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('no_emails')
    expect(audit[0]?.patch_status).toBe('skipped_for_no_match')
    expect(audit[0]?.untrusted_dropped).toBe(1)
    expect(audit[0]?.emails_found).toBe(0)
  })

  it('a Gmail failure is isolated: status error, patch_status skipped_for_upstream_error', async (): Promise<void> => {
    server.use(
      transactionsHandler([makeTxn()]),
      oauthHandler(),
      // 400 is non-retryable, so listMessages fails fast with an AppError.
      http.get(`${GMAIL_API_BASE_URL}/users/me/messages`, () =>
        HttpResponse.text('bad query', { status: 400 }),
      ),
    )

    const result = await runEnrich({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 0, failed: 1, skipped: 0 })
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('error')
    expect(audit[0]?.patch_status).toBe('skipped_for_upstream_error')
    expect(audit[0]?.error).toContain('400')
  })

  it('a malformed transactions response aborts the run and writes a run-aborted audit row', async (): Promise<void> => {
    server.use(
      // `data` is missing `transactions`, so the YNAB client's zod parse throws before any
      // per-transaction work begins — the kind of fatal that would otherwise leave no trail.
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: {} }),
      ),
    )

    await expect(
      runEnrich({ config: makeConfig(), opts: { dryRun: false, verbose: false } }),
    ).rejects.toThrow()

    const audit = readAuditLines()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.transaction_id).toBe(RUN_ABORTED_SENTINEL)
    expect(audit[0]?.status).toBe('error')
    expect(audit[0]?.patch_status).toBe('error')
    expect(audit[0]?.error).toBeTruthy()
  })
})
