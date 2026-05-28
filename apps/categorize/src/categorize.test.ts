import type { Logger } from '@ynab-automation/common/logger'
import type { Category, CategoryGroup, Transaction } from '@ynab-automation/ynab/types'
import { describe, expect, it, vi } from 'vitest'
import type { AnthropicCategorizeClient } from './anthropic/client.js'
import {
  buildAuditEntry,
  type CategorizeAudit,
  categorizeAll,
  filterCategoriesForPrompt,
  findUncategorizedId,
  flattenCategories,
  isEligible,
} from './categorize.js'

const makeTxn = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'txn-1',
  account_id: 'acct-1',
  date: '2026-05-20',
  payee_name: 'Amazon',
  memo: null,
  amount: -15_000,
  transfer_account_id: null,
  transfer_transaction_id: null,
  flag_name: null,
  flag_color: null,
  category_id: null,
  ...overrides,
})

const makeCat = (overrides: Partial<Category> = {}): Category => ({
  id: 'cat-1',
  name: 'Groceries',
  hidden: false,
  deleted: false,
  category_group_id: 'grp-1',
  category_group_name: 'Food',
  ...overrides,
})

describe('isEligible', (): void => {
  const allowed = new Set(['acct-1'])

  it('accepts a normal Amazon transaction in an allowed account', (): void => {
    expect(isEligible({ txn: makeTxn(), allowedAccountIds: allowed })).toBe(true)
  })

  it('rejects transactions in disallowed accounts', (): void => {
    expect(isEligible({ txn: makeTxn({ account_id: 'other' }), allowedAccountIds: allowed })).toBe(
      false,
    )
  })

  it('rejects non-Amazon payees', (): void => {
    expect(isEligible({ txn: makeTxn({ payee_name: 'Costco' }), allowedAccountIds: allowed })).toBe(
      false,
    )
  })

  it('rejects null payee', (): void => {
    expect(isEligible({ txn: makeTxn({ payee_name: null }), allowedAccountIds: allowed })).toBe(
      false,
    )
  })

  it('rejects transfers (transfer_account_id set)', (): void => {
    expect(
      isEligible({
        txn: makeTxn({ transfer_account_id: 'acct-2' }),
        allowedAccountIds: allowed,
      }),
    ).toBe(false)
  })

  it('rejects transfers (transfer_transaction_id set)', (): void => {
    expect(
      isEligible({
        txn: makeTxn({ transfer_transaction_id: 'txn-x' }),
        allowedAccountIds: allowed,
      }),
    ).toBe(false)
  })

  it('rejects transactions already flagged', (): void => {
    expect(
      isEligible({ txn: makeTxn({ flag_name: 'auto-categorized' }), allowedAccountIds: allowed }),
    ).toBe(false)
  })

  it('accepts transactions flagged with a different name', (): void => {
    expect(isEligible({ txn: makeTxn({ flag_name: 'manual' }), allowedAccountIds: allowed })).toBe(
      true,
    )
  })
})

describe('flattenCategories', (): void => {
  it('flattens nested groups into a single array', (): void => {
    const groups: CategoryGroup[] = [
      {
        id: 'g1',
        name: 'Food',
        hidden: false,
        deleted: false,
        categories: [makeCat({ id: 'c1' }), makeCat({ id: 'c2' })],
      },
    ]
    expect(flattenCategories(groups)).toHaveLength(2)
  })

  it('drops hidden groups', (): void => {
    const groups: CategoryGroup[] = [
      {
        id: 'g1',
        name: 'Food',
        hidden: true,
        deleted: false,
        categories: [makeCat()],
      },
    ]
    expect(flattenCategories(groups)).toHaveLength(0)
  })

  it('drops deleted categories within visible groups', (): void => {
    const groups: CategoryGroup[] = [
      {
        id: 'g1',
        name: 'Food',
        hidden: false,
        deleted: false,
        categories: [makeCat({ id: 'c1' }), makeCat({ id: 'c2', deleted: true })],
      },
    ]
    const result = flattenCategories(groups)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('c1')
  })

  it('fills category_group_name from group when undefined on category', (): void => {
    const groups: CategoryGroup[] = [
      {
        id: 'g1',
        name: 'Food',
        hidden: false,
        deleted: false,
        // Simulate a YNAB API response where category_group_name is missing on the row itself.
        categories: [{ ...makeCat(), category_group_name: undefined as unknown as string }],
      },
    ]
    const result = flattenCategories(groups)
    expect(result[0]?.category_group_name).toBe('Food')
  })
})

describe('findUncategorizedId', (): void => {
  it('finds the Uncategorized row in Internal Master Category', (): void => {
    const cats = [
      makeCat({ id: 'u', name: 'Uncategorized', category_group_name: 'Internal Master Category' }),
      makeCat({ id: 'g', name: 'Groceries' }),
    ]
    expect(findUncategorizedId(cats)).toBe('u')
  })

  it('returns undefined if no Uncategorized exists', (): void => {
    expect(findUncategorizedId([makeCat()])).toBeUndefined()
  })

  it('does not match an Uncategorized in a different group', (): void => {
    const cats = [makeCat({ name: 'Uncategorized', category_group_name: 'Food' })]
    expect(findUncategorizedId(cats)).toBeUndefined()
  })
})

describe('filterCategoriesForPrompt', (): void => {
  const noExcluded = new Set<string>()

  it('drops Internal Master Category entries', (): void => {
    const cats = [
      makeCat({ id: 'c1', category_group_name: 'Food' }),
      makeCat({ id: 'u', category_group_name: 'Internal Master Category' }),
    ]
    const result = filterCategoriesForPrompt({ categories: cats, excludedGroups: noExcluded })
    expect(result.map(c => c.id)).toEqual(['c1'])
  })

  it('drops categories whose group is in excludedGroups', (): void => {
    const cats = [
      makeCat({ id: 'c1', category_group_name: 'Food' }),
      makeCat({ id: 'c2', category_group_name: 'Credit Card Payments' }),
    ]
    const result = filterCategoriesForPrompt({
      categories: cats,
      excludedGroups: new Set(['Credit Card Payments']),
    })
    expect(result.map(c => c.id)).toEqual(['c1'])
  })

  it('returns only id and name (drops other fields)', (): void => {
    const cats = [makeCat({ id: 'c1', name: 'Groceries' })]
    expect(filterCategoriesForPrompt({ categories: cats, excludedGroups: noExcluded })).toEqual([
      { id: 'c1', name: 'Groceries' },
    ])
  })
})

describe('buildAuditEntry', (): void => {
  it('builds entry with default status ok and extra fields', (): void => {
    const entry = buildAuditEntry({
      txn: makeTxn(),
      categoryId: 'c1',
      categoryName: 'Groceries',
      extra: { latency_ms: 100 },
    })
    expect(entry.transaction_id).toBe('txn-1')
    expect(entry.amount_dollars).toBe(-15)
    expect(entry.status).toBe('ok')
    expect(entry.latency_ms).toBe(100)
  })

  it('extra can override default status', (): void => {
    const entry = buildAuditEntry({
      txn: makeTxn(),
      categoryId: null,
      categoryName: null,
      extra: { status: 'error', error: 'boom' },
    })
    expect(entry.status).toBe('error')
    expect(entry.error).toBe('boom')
  })

  it('emits ISO timestamp', (): void => {
    const entry = buildAuditEntry({
      txn: makeTxn(),
      categoryId: null,
      categoryName: null,
      extra: {},
    })
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('categorizeAll', (): void => {
  const silentLogger: Logger<CategorizeAudit> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    audit: vi.fn(),
  }
  const categories = {
    promptCategories: [{ id: 'cat-1', name: 'Groceries' }],
    uncategorizedId: 'unc',
    validCategoryIds: new Set(['cat-1', 'unc']),
    categoryNamesById: new Map([
      ['cat-1', 'Groceries'],
      ['unc', 'Uncategorized'],
    ]),
    routingHints: [],
  }

  it('rethrows when llm.categorize throws a non-AnthropicError', async (): Promise<void> => {
    const llm: AnthropicCategorizeClient = {
      categorize: async () => {
        throw new Error('programming bug')
      },
    }

    await expect(
      categorizeAll({
        eligible: [makeTxn()],
        categories,
        llm,
        logger: silentLogger,
      }),
    ).rejects.toThrow('programming bug')
  })
})
