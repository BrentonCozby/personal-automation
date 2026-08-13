import type { Transaction } from '@personal-automation/ynab/types'
import { describe, expect, it } from 'vitest'
import { isEligible } from './enrich.js'

const ACCOUNT = 'acct-A'
const allowedAccountIds = new Set([ACCOUNT])

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    account_id: ACCOUNT,
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

describe('isEligible', (): void => {
  it('accepts an empty memo (null, blank, or whitespace-only) on an allowed Amazon charge', (): void => {
    expect(isEligible({ txn: txn({ memo: null }), allowedAccountIds })).toBe(true)
    expect(isEligible({ txn: txn({ memo: '' }), allowedAccountIds })).toBe(true)
    expect(isEligible({ txn: txn({ memo: '   ' }), allowedAccountIds })).toBe(true)
  })

  it('rejects an account not in the allowlist', (): void => {
    expect(isEligible({ txn: txn({ account_id: 'other' }), allowedAccountIds })).toBe(false)
  })

  it('rejects non-Amazon payees', (): void => {
    expect(isEligible({ txn: txn({ payee_name: 'Target' }), allowedAccountIds })).toBe(false)
  })

  it('rejects transfers (either transfer field set)', (): void => {
    expect(isEligible({ txn: txn({ transfer_account_id: 'x' }), allowedAccountIds })).toBe(false)
    expect(isEligible({ txn: txn({ transfer_transaction_id: 'x' }), allowedAccountIds })).toBe(
      false,
    )
  })

  it('rejects a transaction with a memo you typed: manual notes are never overwritten', (): void => {
    expect(
      isEligible({ txn: txn({ memo: 'gift for mom, do not touch' }), allowedAccountIds }),
    ).toBe(false)
  })

  it('rejects a memo this job already generated (non-empty): clear it to regenerate', (): void => {
    expect(isEligible({ txn: txn({ memo: 'auto-gen: USB cable ($9)' }), allowedAccountIds })).toBe(
      false,
    )
  })
})
