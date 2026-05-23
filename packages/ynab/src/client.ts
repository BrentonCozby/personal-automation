import { YnabApiError } from '@ynab-automation/common/errors'
import { withRetry } from '@ynab-automation/common/retry'
import { YNAB_API_BASE_URL } from './constants.js'
import { categoryGroupsResponseSchema, transactionsResponseSchema } from './schemas.js'
import type { CategoryGroup, Transaction, TransactionPatch } from './types.js'

type YnabClientInit = { token: string; budgetId: string }

export type YnabClient = {
  getCategoryGroups: () => Promise<CategoryGroup[]>
  getTransactionsForAccounts: ({
    accountIds,
    sinceDate,
  }: {
    accountIds: Iterable<string>
    sinceDate: string
  }) => Promise<Transaction[]>
  patchTransactions: (patches: TransactionPatch[]) => Promise<void>
}

export function createYnabClient({ token, budgetId }: YnabClientInit): YnabClient {
  function request<T>({
    path,
    init = {},
    schema,
  }: {
    path: string
    init?: RequestInit
    schema?: { parse: (data: unknown) => T }
  }): Promise<T> {
    return withRetry(async () => {
      const res = await fetch(`${YNAB_API_BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
      if (!res.ok) {
        const body = await res.text()
        throw new YnabApiError({
          status: res.status,
          method: init.method || 'GET',
          path,
          body,
        })
      }
      if (res.status === 204) return undefined as T
      const json = await res.json()

      return schema ? schema.parse(json) : (json as T)
    })
  }

  async function getCategoryGroups(): Promise<CategoryGroup[]> {
    const res = await request({
      path: `/budgets/${budgetId}/categories`,
      schema: categoryGroupsResponseSchema,
    })

    return res.data.category_groups
  }

  async function getTransactionsForAccounts({
    accountIds,
    sinceDate,
  }: {
    accountIds: Iterable<string>
    sinceDate: string
  }): Promise<Transaction[]> {
    // Per-account fetch keeps each response small even at 30+ day lookbacks.
    const perAccount = await Promise.all(
      [...accountIds].map(accountId =>
        request({
          path: `/budgets/${budgetId}/accounts/${accountId}/transactions?since_date=${sinceDate}`,
          schema: transactionsResponseSchema,
        }).then(r => r.data.transactions),
      ),
    )

    return perAccount.flat()
  }

  async function patchTransactions(patches: TransactionPatch[]): Promise<void> {
    await request({
      path: `/budgets/${budgetId}/transactions`,
      init: {
        method: 'PATCH',
        body: JSON.stringify({ transactions: patches }),
      },
    })
  }

  return { getCategoryGroups, getTransactionsForAccounts, patchTransactions }
}
