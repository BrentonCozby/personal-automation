import { RUN_ABORTED_SENTINEL } from '@ynab-automation/common/logger'
import { describe, expect, it } from 'vitest'
import { type AuditRow, buildDigest } from './digest.js'

function row(overrides: Partial<AuditRow>): AuditRow {
  return {
    app: 'categorize',
    transaction_id: 't-1',
    payee_name: 'Amazon',
    amount_dollars: -42.1,
    patch_status: 'success',
    ...overrides,
  }
}

describe('buildDigest', (): void => {
  it('returns errorCount 0 and bracketed subject on a clean run', (): void => {
    const digest = buildDigest({ rows: [row({}), row({ transaction_id: 't-2' })] })

    expect(digest.errorCount).toBe(0)
    expect(digest.subject).toBe('YNAB Automation — 0 errors')
  })

  it('pluralizes singular vs plural in the subject', (): void => {
    const one = buildDigest({ rows: [row({ patch_status: 'error', error: 'boom' })] })
    const many = buildDigest({
      rows: [
        row({ transaction_id: 't1', patch_status: 'error', error: 'a' }),
        row({ transaction_id: 't2', patch_status: 'error', error: 'b' }),
      ],
    })

    expect(one.subject).toBe('YNAB Automation — 1 error')
    expect(many.subject).toBe('YNAB Automation — 2 errors')
  })

  it('groups by app and counts errors vs successes per app', (): void => {
    const digest = buildDigest({
      rows: [
        row({ app: 'categorize', transaction_id: 'a', patch_status: 'success' }),
        row({ app: 'categorize', transaction_id: 'b', patch_status: 'success' }),
        row({
          app: 'categorize',
          transaction_id: 'c',
          patch_status: 'error',
          error: 'boom',
        }),
        row({
          app: 'enrich-memos',
          transaction_id: 'd',
          patch_status: 'skipped_for_upstream_error',
          error: 'timeout',
        }),
        row({ app: 'enrich-memos', transaction_id: 'e', patch_status: 'success' }),
      ],
    })

    expect(digest.errorCount).toBe(2)
    expect(digest.body).toContain('categorize — 1 error, 2 successes')
    expect(digest.body).toContain('enrich-memos — 1 error, 1 success')
  })

  it('excludes skipped_for_dry_run rows from both counts', (): void => {
    const digest = buildDigest({
      rows: [
        row({ transaction_id: 'a', patch_status: 'skipped_for_dry_run' }),
        row({ transaction_id: 'b', patch_status: 'skipped_for_dry_run' }),
        row({ transaction_id: 'c', patch_status: 'success' }),
        row({ transaction_id: 'd', patch_status: 'error', error: 'boom' }),
      ],
    })

    expect(digest.errorCount).toBe(1)
    expect(digest.body).toContain('categorize — 1 error, 1 success')
  })

  it('renders each error row with labeled fields and quotes the error verbatim', (): void => {
    const digest = buildDigest({
      rows: [
        row({
          transaction_id: 'abc123',
          payee_name: 'Amazon',
          amount_dollars: -42.1,
          patch_status: 'error',
          error: 'rate_limit_error: 429 from anthropic',
        }),
      ],
    })

    expect(digest.body).toContain('Transaction abc123')
    expect(digest.body).toContain('Payee:   Amazon')
    expect(digest.body).toContain('Amount:  -$42.10')
    expect(digest.body).toContain('Status:  error')
    expect(digest.body).toContain('Reason:  rate_limit_error: 429 from anthropic')
  })

  it('formats positive amounts without a sign and rounds to two decimals', (): void => {
    const digest = buildDigest({
      rows: [row({ patch_status: 'error', error: 'x', amount_dollars: 12.345 })],
    })

    expect(digest.body).toContain('Amount:  $12.35')
  })

  it('falls back to placeholders when payee or error are missing', (): void => {
    const digest = buildDigest({ rows: [row({ patch_status: 'error', payee_name: null })] })

    expect(digest.body).toContain('Payee:   (no payee)')
    expect(digest.body).toContain('Reason:  (no error message recorded)')
  })

  it('shows a (no errors) line for apps that ran clean alongside apps that failed', (): void => {
    const digest = buildDigest({
      rows: [
        row({ app: 'categorize', transaction_id: 'a', patch_status: 'success' }),
        row({
          app: 'enrich-memos',
          transaction_id: 'b',
          patch_status: 'error',
          error: 'boom',
        }),
      ],
    })

    expect(digest.errorCount).toBe(1)
    expect(digest.body).toContain('categorize — 0 errors, 1 success')
    expect(digest.body).toContain('(no errors)')
    expect(digest.body).toContain('enrich-memos — 1 error, 0 successes')
  })

  it('renders a run-aborted row as a run-level header instead of a transaction', (): void => {
    const digest = buildDigest({
      rows: [
        row({
          transaction_id: RUN_ABORTED_SENTINEL,
          payee_name: null,
          amount_dollars: 0,
          patch_status: 'error',
          error: 'TypeError: Cannot read properties of undefined (reading "foo")',
        }),
      ],
    })

    expect(digest.errorCount).toBe(1)
    expect(digest.body).toContain('RUN ABORTED')
    expect(digest.body).toContain('Reason:  TypeError: Cannot read properties of undefined')
    expect(digest.body).not.toContain('Transaction <run-aborted>')
    expect(digest.body).not.toContain('Amount:')
  })

  it('renders apps in stable alphabetical order', (): void => {
    const digest = buildDigest({
      rows: [
        row({ app: 'zeta', transaction_id: 'z', patch_status: 'error', error: 'x' }),
        row({ app: 'alpha', transaction_id: 'a', patch_status: 'error', error: 'y' }),
      ],
    })

    const alphaIdx = digest.body.indexOf('alpha —')
    const zetaIdx = digest.body.indexOf('zeta —')
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(zetaIdx).toBeGreaterThan(alphaIdx)
  })
})
