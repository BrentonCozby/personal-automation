import { YnabApiError } from '@personal-automation/common/errors'
import { withRetry } from '@personal-automation/common/retry'
import { YNAB_API_BASE_URL, YNAB_REQUEST_TIMEOUT_MS } from './constants.js'
import {
  categoryGroupsResponseSchema,
  monthResponseSchema,
  monthsResponseSchema,
  patchTransactionsResponseSchema,
  transactionsResponseSchema,
} from './schemas.js'
import type { CategoryGroup, MonthCategory, Transaction, TransactionPatch } from './types.js'

type YnabClientInit = { token: string; budgetId: string }

export type PatchTransactionsResult = { updatedIds: string[] }

export type YnabClient = {
  getCategoryGroups: () => Promise<CategoryGroup[]>
  /** Each category's activity in one month, in milliunits, spending negative. `month` is the first day, as 2026-08-01. */
  getMonthCategories: (month: string) => Promise<MonthCategory[]>
  /** The months the budget has, as first-of-month dates, oldest first. A request for any other month is a 404. */
  listMonths: () => Promise<string[]>
  getTransactionsForAccounts: ({
    accountIds,
    sinceDate,
  }: {
    accountIds: Iterable<string>
    sinceDate: string
  }) => Promise<Transaction[]>
  patchTransactions: (patches: TransactionPatch[]) => Promise<PatchTransactionsResult>
}

export function createYnabClient({ token, budgetId }: YnabClientInit): YnabClient {
  function request<T>({
    path,
    init = {},
    schema,
  }: {
    path: string
    init?: RequestInit
    schema: { parse: (data: unknown) => T }
  }): Promise<T> {
    return withRetry(async () => {
      const res = await fetch(`${YNAB_API_BASE_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(YNAB_REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
      const method = init.method || 'GET'
      if (!res.ok) {
        const body = await res.text()
        throw new YnabApiError({ status: res.status, method, path, body })
      }
      if (res.status === 204) {
        throw new YnabApiError({ status: 204, method, path, body: 'unexpected empty response' })
      }
      const json = await res.json()

      return schema.parse(json)
    })
  }

  async function getCategoryGroups(): Promise<CategoryGroup[]> {
    const res = await request({
      path: `/budgets/${budgetId}/categories`,
      schema: categoryGroupsResponseSchema,
    })

    return res.data.category_groups
  }

  async function getMonthCategories(month: string): Promise<MonthCategory[]> {
    const res = await request({
      path: `/budgets/${budgetId}/months/${month}`,
      schema: monthResponseSchema,
    })

    return res.data.month.categories
  }

  async function listMonths(): Promise<string[]> {
    const res = await request({ path: `/budgets/${budgetId}/months`, schema: monthsResponseSchema })

    return res.data.months
      .filter(m => !m.deleted)
      .map(m => m.month)
      .sort()
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

  async function patchTransactions(patches: TransactionPatch[]): Promise<PatchTransactionsResult> {
    const res = await request({
      path: `/budgets/${budgetId}/transactions`,
      init: {
        method: 'PATCH',
        body: JSON.stringify({ transactions: patches }),
      },
      schema: patchTransactionsResponseSchema,
    })

    return { updatedIds: res.data.transaction_ids }
  }

  return {
    getCategoryGroups,
    getMonthCategories,
    listMonths,
    getTransactionsForAccounts,
    patchTransactions,
  }
}
