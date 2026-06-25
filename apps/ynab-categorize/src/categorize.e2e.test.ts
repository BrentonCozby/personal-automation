import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Logger, RUN_ABORTED_SENTINEL } from '@personal-automation/common/logger'
import { setupMswServer } from '@personal-automation/common/test-msw'
import { YNAB_API_BASE_URL } from '@personal-automation/ynab/constants'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CategorizeAudit, runCategorize } from './categorize.js'
import type { Config } from './config.js'

const BUDGET_ID = '11111111-1111-1111-1111-111111111111'
const ACCOUNT_ID = 'acct-A'
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

const server = setupMswServer()

let auditDir: string

beforeEach((): void => {
  auditDir = mkdtempSync(join(tmpdir(), 'cat-e2e-'))
})

afterEach((): void => {
  rmSync(auditDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ynabToken: 'test-token',
    budgetId: BUDGET_ID,
    allowedAccountIds: new Set([ACCOUNT_ID]),
    lookbackDays: 5,
    anthropicApiKey: 'test-anthropic-key',
    anthropicModel: 'claude-haiku-4-5',
    auditDir,
    excludedCategoryGroups: new Set(),
    categoryRoutingHints: [],
    ...overrides,
  }
}

// Anthropic Messages API response shape — the SDK parses `content[0].text` against the
// Zod schema passed to `output_config.format` and surfaces it as `parsed_output`.
function anthropicResponse(content: string): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  }
}

const categoriesResponse = {
  data: {
    category_groups: [
      {
        id: 'gFood',
        name: 'Food',
        hidden: false,
        deleted: false,
        categories: [
          {
            id: 'cGroceries',
            name: 'Groceries',
            hidden: false,
            deleted: false,
            category_group_id: 'gFood',
            category_group_name: 'Food',
          },
        ],
      },
      {
        id: 'gInternal',
        name: 'Internal Master Category',
        hidden: false,
        deleted: false,
        categories: [
          {
            id: 'cUncategorized',
            name: 'Uncategorized',
            hidden: false,
            deleted: false,
            category_group_id: 'gInternal',
            category_group_name: 'Internal Master Category',
          },
        ],
      },
    ],
  },
}

function makeTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'txn-1',
    account_id: ACCOUNT_ID,
    date: '2026-05-20',
    payee_name: 'Amazon',
    memo: 'organic eggs',
    amount: -15_000,
    transfer_account_id: null,
    transfer_transaction_id: null,
    flag_name: null,
    flag_color: null,
    category_id: null,
    ...overrides,
  }
}

function readAuditLines(): CategorizeAudit[] {
  const files = readdirSync(auditDir)
  const lines: CategorizeAudit[] = []
  for (const f of files) {
    const content = readFileSync(join(auditDir, f), 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as CategorizeAudit)
    }
  }

  return lines
}

describe('runCategorize (e2e)', (): void => {
  it('happy path: categorizes, PATCHes, writes ok audit entry', async (): Promise<void> => {
    type PatchBody = { transactions?: unknown[] }
    let patchedBody: PatchBody | null = null
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [makeTxn()] } }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(anthropicResponse('{"category_id":"cGroceries"}')),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, async ({ request }) => {
        patchedBody = (await request.json()) as PatchBody

        return HttpResponse.json({ data: { transaction_ids: ['txn-1'] } }, { status: 209 })
      }),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 1, failed: 0, skipped: 0 })
    // Cast: TS narrows `patchedBody` to its initializer type because msw assigns it inside a
    // callback that control-flow analysis can't see.
    expect((patchedBody as PatchBody | null)?.transactions).toHaveLength(1)

    const audit = readAuditLines()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.app).toBe('ynab-categorize')
    expect(audit[0]?.status).toBe('categorized')
    expect(audit[0]?.outcome).toBe('applied')
    expect(audit[0]?.chosen_category_id).toBe('cGroceries')
  })

  it('falls back to Uncategorized when LLM picks an unknown id', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [makeTxn()] } }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(anthropicResponse('{"category_id":"made-up-id"}')),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, () =>
        HttpResponse.json({ data: { transaction_ids: ['txn-1'] } }, { status: 209 }),
      ),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result.succeeded).toBe(1)
    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('fallback')
    expect(audit[0]?.chosen_category_id).toBe('cUncategorized')
  })

  it('dry-run does not PATCH but still emits audit', async (): Promise<void> => {
    let patchCalled = false
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [makeTxn()] } }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(anthropicResponse('{"category_id":"cGroceries"}')),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, () => {
        patchCalled = true

        return HttpResponse.json({ data: { transaction_ids: [] } }, { status: 209 })
      }),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: true, verbose: false },
    })

    expect(patchCalled).toBe(false)
    expect(result.skipped).toBe(1)
    const audit = readAuditLines()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.status).toBe('categorized')
    expect(audit[0]?.outcome).toBe('skipped_for_dry_run')
  })

  it('PATCH failure marks audit outcome failed', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [makeTxn()] } }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(anthropicResponse('{"category_id":"cGroceries"}')),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, () =>
        HttpResponse.text('budget locked', { status: 400 }),
      ),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)

    const audit = readAuditLines()
    expect(audit[0]?.status).toBe('categorized')
    expect(audit[0]?.outcome).toBe('failed')
    expect(audit[0]?.error).toContain('400')
  })

  it('PATCH response with unexpected shape rejects the run and writes a run-aborted audit entry', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [makeTxn()] } }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(anthropicResponse('{"category_id":"cGroceries"}')),
      ),
      // 200 with a body that fails patchTransactionsResponseSchema.
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, () =>
        HttpResponse.json({ data: { wrong_field: [] } }),
      ),
    )

    await expect(
      runCategorize({ config: makeConfig(), opts: { dryRun: false, verbose: false } }),
    ).rejects.toThrow()

    const audit = readAuditLines()
    const aborted = audit.find(e => e.transaction_id === RUN_ABORTED_SENTINEL)
    expect(aborted).toBeDefined()
    expect(aborted?.status).toBe('error')
    expect(aborted?.outcome).toBe('failed')
    expect(aborted?.error).toBeTruthy()
  })

  it('writes a run-aborted audit entry when the categories endpoint returns a bad shape', async (): Promise<void> => {
    server.use(
      // Malformed: top-level `data` missing `category_groups`. This rejects in the YNAB
      // client's Zod parse before any txn work begins — exactly the kind of fatal that
      // would otherwise leave no audit trail.
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json({ data: {} }),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [] } }),
      ),
    )

    await expect(
      runCategorize({ config: makeConfig(), opts: { dryRun: false, verbose: false } }),
    ).rejects.toThrow()

    const audit = readAuditLines()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.transaction_id).toBe(RUN_ABORTED_SENTINEL)
    expect(audit[0]?.outcome).toBe('failed')
    expect(audit[0]?.status).toBe('error')
  })

  it('propagates the original error when the run-aborted audit write itself fails', async (): Promise<void> => {
    server.use(
      // Malformed categories response rejects before any txn work — same fatal as above.
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json({ data: {} }),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [] } }),
      ),
    )

    // Logger whose audit() fails (disk full / perms) when the wrapper records the
    // run-aborted row. The original fatal must still surface, not this write error.
    const auditWriteError = new Error('audit write failed')
    const logger: Logger<CategorizeAudit> = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      audit: vi.fn(() => {
        throw auditWriteError
      }),
    }

    const caught = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
      logger,
    }).catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toContain('audit write failed')
    expect(logger.audit).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it('categorize failure marks audit status error + outcome failed_upstream', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () => HttpResponse.json({ data: { transactions: [makeTxn()] } }),
      ),
      // 400 is non-retryable, so the categorize step fails fast and doesn't hammer msw.
      http.post(ANTHROPIC_MESSAGES_URL, () => HttpResponse.text('bad request', { status: 400 })),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(0)
    const audit = readAuditLines()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.status).toBe('error')
    expect(audit[0]?.outcome).toBe('failed_upstream')
  })

  it('partial PATCH success: confirmed ids get outcome applied, missing ids get failed', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () =>
          HttpResponse.json({
            data: {
              transactions: [
                makeTxn({ id: 'txn-1' }),
                makeTxn({ id: 'txn-2', memo: 'paper towels' }),
              ],
            },
          }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () =>
        HttpResponse.json(anthropicResponse('{"category_id":"cGroceries"}')),
      ),
      http.patch(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/transactions`, () =>
        HttpResponse.json({ data: { transaction_ids: ['txn-1'] } }, { status: 209 }),
      ),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(result).toEqual({ succeeded: 1, failed: 1, skipped: 0 })

    const audit = readAuditLines()
    const byId = new Map(audit.map(e => [e.transaction_id, e]))
    expect(byId.get('txn-1')?.status).toBe('categorized')
    expect(byId.get('txn-1')?.outcome).toBe('applied')
    expect(byId.get('txn-2')?.status).toBe('categorized')
    expect(byId.get('txn-2')?.outcome).toBe('failed')
    expect(byId.get('txn-2')?.error).toContain('transaction_ids')
  })

  it('skips a flagged transaction that already has a real category', async (): Promise<void> => {
    let llmCalled = false
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/categories`, () =>
        HttpResponse.json(categoriesResponse),
      ),
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${BUDGET_ID}/accounts/${ACCOUNT_ID}/transactions`,
        () =>
          HttpResponse.json({
            data: {
              transactions: [
                makeTxn({
                  flag_name: 'auto-categorized',
                  flag_color: 'yellow',
                  category_id: 'cGroceries',
                }),
              ],
            },
          }),
      ),
      http.post(ANTHROPIC_MESSAGES_URL, () => {
        llmCalled = true

        return HttpResponse.json(anthropicResponse('{}'))
      }),
    )

    const result = await runCategorize({
      config: makeConfig(),
      opts: { dryRun: false, verbose: false },
    })

    expect(llmCalled).toBe(false)
    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 0 })
    expect(readAuditLines()).toHaveLength(0)
  })
})
