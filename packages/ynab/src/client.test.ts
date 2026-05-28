import { YnabApiError } from '@ynab-automation/common/errors'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createYnabClient } from './client.js'
import { YNAB_API_BASE_URL } from './constants.js'

const VALID_UUID = '11111111-1111-1111-1111-111111111111'

const server = setupServer()

beforeAll((): void => server.listen({ onUnhandledRequest: 'error' }))
afterEach((): void => server.resetHandlers())
afterAll((): void => server.close())

function makeClient(): ReturnType<typeof createYnabClient> {
  return createYnabClient({ token: 'test-token', budgetId: VALID_UUID })
}

describe('createYnabClient.getCategoryGroups', (): void => {
  it('fetches and parses category groups', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/categories`, ({ request }) => {
        expect(request.headers.get('Authorization')).toBe('Bearer test-token')

        return HttpResponse.json({
          data: {
            category_groups: [
              {
                id: 'g1',
                name: 'Food',
                hidden: false,
                deleted: false,
                categories: [
                  {
                    id: 'c1',
                    name: 'Groceries',
                    hidden: false,
                    deleted: false,
                    category_group_id: 'g1',
                    category_group_name: 'Food',
                  },
                ],
              },
            ],
          },
        })
      }),
    )

    const groups = await makeClient().getCategoryGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.categories).toHaveLength(1)
  })

  it('throws YnabApiError on 4xx', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/categories`, () =>
        HttpResponse.text('Unauthorized', { status: 401 }),
      ),
    )

    await expect(makeClient().getCategoryGroups()).rejects.toThrow(YnabApiError)
  })

  it('throws on shape mismatch (zod validation)', async (): Promise<void> => {
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/categories`, () =>
        HttpResponse.json({ data: { wrong: 'shape' } }),
      ),
    )

    await expect(makeClient().getCategoryGroups()).rejects.toThrow()
  })

  it('retries on 500 and eventually succeeds', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.get(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/categories`, () => {
        calls++
        if (calls < 2) return HttpResponse.text('boom', { status: 500 })

        return HttpResponse.json({ data: { category_groups: [] } })
      }),
    )

    const groups = await makeClient().getCategoryGroups()
    expect(groups).toEqual([])
    expect(calls).toBe(2)
  })
})

describe('createYnabClient.getTransactionsForAccounts', (): void => {
  it('fetches per-account in parallel and flattens', async (): Promise<void> => {
    server.use(
      http.get(
        `${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/accounts/acct-A/transactions`,
        ({ request }) => {
          const url = new URL(request.url)
          expect(url.searchParams.get('since_date')).toBe('2026-05-01')

          return HttpResponse.json({
            data: { transactions: [makeTxn('t1', 'acct-A')] },
          })
        },
      ),
      http.get(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/accounts/acct-B/transactions`, () =>
        HttpResponse.json({
          data: { transactions: [makeTxn('t2', 'acct-B'), makeTxn('t3', 'acct-B')] },
        }),
      ),
    )

    const txns = await makeClient().getTransactionsForAccounts({
      accountIds: ['acct-A', 'acct-B'],
      sinceDate: '2026-05-01',
    })
    expect(txns.map(t => t.id).sort()).toEqual(['t1', 't2', 't3'])
  })
})

describe('createYnabClient.patchTransactions', (): void => {
  it('PATCHes with body and returns updatedIds from response', async (): Promise<void> => {
    let receivedBody: unknown = null
    server.use(
      http.patch(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/transactions`, async ({ request }) => {
        receivedBody = await request.json()

        return HttpResponse.json({ data: { transaction_ids: ['t1', 't2'] } }, { status: 209 })
      }),
    )

    const result = await makeClient().patchTransactions([
      { id: 't1', category_id: 'c1', flag_color: 'yellow', flag_name: 'auto-categorized' },
      { id: 't2', category_id: 'c2', flag_color: 'yellow', flag_name: 'auto-categorized' },
    ])

    expect(receivedBody).toEqual({
      transactions: [
        { id: 't1', category_id: 'c1', flag_color: 'yellow', flag_name: 'auto-categorized' },
        { id: 't2', category_id: 'c2', flag_color: 'yellow', flag_name: 'auto-categorized' },
      ],
    })
    expect(result).toEqual({ updatedIds: ['t1', 't2'] })
  })

  it('returns only the ids YNAB confirms (partial success)', async (): Promise<void> => {
    server.use(
      http.patch(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/transactions`, () =>
        HttpResponse.json({ data: { transaction_ids: ['t1'] } }, { status: 209 }),
      ),
    )

    const result = await makeClient().patchTransactions([
      { id: 't1', category_id: 'c1', flag_color: 'yellow', flag_name: 'auto-categorized' },
      { id: 't2', category_id: 'c2', flag_color: 'yellow', flag_name: 'auto-categorized' },
    ])

    expect(result).toEqual({ updatedIds: ['t1'] })
  })

  it('propagates YnabApiError on 4xx and does not retry (client error)', async (): Promise<void> => {
    let calls = 0
    server.use(
      http.patch(`${YNAB_API_BASE_URL}/budgets/${VALID_UUID}/transactions`, () => {
        calls++

        return HttpResponse.text('bad request', { status: 400 })
      }),
    )

    await expect(
      makeClient().patchTransactions([
        { id: 't1', category_id: 'c1', flag_color: 'yellow', flag_name: 'auto-categorized' },
      ]),
    ).rejects.toThrow(YnabApiError)
    expect(calls).toBe(1)
  })
})

function makeTxn(
  id: string,
  accountId: string,
): {
  id: string
  account_id: string
  date: string
  payee_name: string
  memo: null
  amount: number
  transfer_account_id: null
  transfer_transaction_id: null
  flag_name: null
  flag_color: null
  category_id: null
} {
  return {
    id,
    account_id: accountId,
    date: '2026-05-20',
    payee_name: 'Amazon',
    memo: null,
    amount: -15_000,
    transfer_account_id: null,
    transfer_transaction_id: null,
    flag_name: null,
    flag_color: null,
    category_id: null,
  }
}
