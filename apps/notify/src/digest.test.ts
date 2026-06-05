import { RUN_ABORTED_SENTINEL } from '@personal-automation/common/logger'
import { describe, expect, it } from 'vitest'
import { type AuditRow, buildDigest } from './digest.js'

function row(overrides: Partial<AuditRow>): AuditRow {
  return {
    app: 'ynab-categorize',
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
    expect(digest.subject).toBe('Personal Automation — 0 errors')
  })

  it('pluralizes singular vs plural in the subject', (): void => {
    const one = buildDigest({ rows: [row({ patch_status: 'error', error: 'boom' })] })
    const many = buildDigest({
      rows: [
        row({ transaction_id: 't1', patch_status: 'error', error: 'a' }),
        row({ transaction_id: 't2', patch_status: 'error', error: 'b' }),
      ],
    })

    expect(one.subject).toBe('Personal Automation — 1 error')
    expect(many.subject).toBe('Personal Automation — 2 errors')
  })

  it('groups by app and counts errors vs successes per app', (): void => {
    const digest = buildDigest({
      rows: [
        row({ app: 'ynab-categorize', transaction_id: 'a', patch_status: 'success' }),
        row({ app: 'ynab-categorize', transaction_id: 'b', patch_status: 'success' }),
        row({
          app: 'ynab-categorize',
          transaction_id: 'c',
          patch_status: 'error',
          error: 'boom',
        }),
        row({
          app: 'ynab-enrich-memos',
          transaction_id: 'd',
          patch_status: 'skipped_for_upstream_error',
          error: 'timeout',
        }),
        row({ app: 'ynab-enrich-memos', transaction_id: 'e', patch_status: 'success' }),
      ],
    })

    expect(digest.errorCount).toBe(2)
    expect(digest.body).toContain('ynab-categorize — 1 error, 2 successes')
    expect(digest.body).toContain('ynab-enrich-memos — 1 error, 1 success')
  })

  it('excludes skipped_for_dry_run and skipped_for_no_match rows from both counts', (): void => {
    const digest = buildDigest({
      rows: [
        row({ transaction_id: 'a', patch_status: 'skipped_for_dry_run' }),
        // Benign "nothing to enrich" — must not read as an error in the digest.
        row({ transaction_id: 'b', patch_status: 'skipped_for_no_match' }),
        row({ transaction_id: 'c', patch_status: 'success' }),
        row({ transaction_id: 'd', patch_status: 'error', error: 'boom' }),
      ],
    })

    expect(digest.errorCount).toBe(1)
    expect(digest.body).toContain('ynab-categorize — 1 error, 1 success')
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

  it('lists successes for a clean app alongside an app that failed', (): void => {
    const digest = buildDigest({
      rows: [
        row({
          app: 'ynab-categorize',
          transaction_id: 'a',
          payee_name: 'Whole Foods',
          patch_status: 'success',
          result_summary: 'Groceries',
        }),
        row({
          app: 'ynab-enrich-memos',
          transaction_id: 'b',
          patch_status: 'error',
          error: 'boom',
        }),
      ],
    })

    expect(digest.errorCount).toBe(1)
    expect(digest.body).toContain('ynab-categorize — 0 errors, 1 success')
    expect(digest.body).toContain('Successes:')
    expect(digest.body).toContain('Whole Foods')
    expect(digest.body).toContain('→  Groceries')
    expect(digest.body).toContain('ynab-enrich-memos — 1 error, 0 successes')
  })

  it('shows the result summary on success rows and falls back to (applied) when absent', (): void => {
    const withSummary = buildDigest({
      rows: [
        row({
          patch_status: 'success',
          payee_name: 'Amazon',
          result_summary: 'auto-gen: AAA batteries',
        }),
      ],
    })
    const withoutSummary = buildDigest({
      rows: [row({ patch_status: 'success', payee_name: 'Amazon', result_summary: null })],
    })

    expect(withSummary.body).toContain('Amazon  -$42.10')
    expect(withSummary.body).toContain('→  auto-gen: AAA batteries')
    expect(withoutSummary.body).toContain('→  (applied)')
  })

  it('shows the memo on success rows so the chosen category can be judged against it', (): void => {
    const digest = buildDigest({
      rows: [
        row({
          patch_status: 'success',
          payee_name: 'Amazon',
          memo: 'auto-gen: AAA batteries (24-pack)',
          result_summary: 'Household Supplies',
        }),
      ],
    })

    expect(digest.body).toContain('memo: auto-gen: AAA batteries (24-pack)')
    expect(digest.body).toContain('→  Household Supplies')
    expect(digest.html).toContain('memo: auto-gen: AAA batteries (24-pack)')
    expect(digest.html).toContain('Household Supplies')
  })

  it('shows the transaction date on both success and error rows', (): void => {
    const digest = buildDigest({
      rows: [
        row({ transaction_id: 's', patch_status: 'success', transaction_date: '2026-06-03' }),
        row({
          transaction_id: 'e',
          patch_status: 'error',
          error: 'boom',
          transaction_date: '2026-05-28',
        }),
      ],
    })

    expect(digest.body).toContain('Jun 3, 2026')
    expect(digest.body).toContain('Date:    May 28, 2026')
    expect(digest.html).toContain('Jun 3, 2026')
    expect(digest.html).toContain('May 28, 2026')
  })

  it('omits the date when a row has no transaction_date', (): void => {
    const digest = buildDigest({
      rows: [row({ patch_status: 'error', error: 'boom', transaction_date: null })],
    })

    expect(digest.body).not.toContain('Date:')
  })

  it('shows a nothing-to-report line for an app with no errors and no successes', (): void => {
    const digest = buildDigest({
      rows: [
        row({
          app: 'ynab-enrich-memos',
          transaction_id: 'a',
          patch_status: 'skipped_for_no_match',
        }),
      ],
    })

    expect(digest.errorCount).toBe(0)
    expect(digest.body).toContain('ynab-enrich-memos — 0 errors, 0 successes')
    expect(digest.body).toContain('(nothing to report)')
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

  describe('html', (): void => {
    it('emits an HTML document carrying the app name, transaction, and error', (): void => {
      const digest = buildDigest({
        rows: [
          row({
            app: 'ynab-enrich-memos',
            transaction_id: 'abc123',
            payee_name: 'Amazon',
            amount_dollars: -116.25,
            patch_status: 'skipped_for_upstream_error',
            error: 'Google OAuth token refresh → 400',
          }),
        ],
      })

      expect(digest.html).toContain('<!doctype html>')
      expect(digest.html).toContain('ynab-enrich-memos')
      expect(digest.html).toContain('abc123')
      expect(digest.html).toContain('Amazon')
      expect(digest.html).toContain('-$116.25')
      expect(digest.html).toContain('skipped_for_upstream_error')
      expect(digest.html).toContain('Google OAuth token refresh → 400')
    })

    it('escapes HTML in error messages and payee names', (): void => {
      const digest = buildDigest({
        rows: [
          row({
            payee_name: 'Tom & Jerry <Co>',
            patch_status: 'error',
            error: '<script>alert("x")</script> & done',
          }),
        ],
      })

      expect(digest.html).toContain('Tom &amp; Jerry &lt;Co&gt;')
      expect(digest.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; done')
      expect(digest.html).not.toContain('<script>alert')
    })

    it('renders a run-aborted row as a banner rather than a transaction card', (): void => {
      const digest = buildDigest({
        rows: [
          row({
            transaction_id: RUN_ABORTED_SENTINEL,
            payee_name: null,
            amount_dollars: 0,
            patch_status: 'error',
            error: 'TypeError: boom',
          }),
        ],
      })

      expect(digest.html).toContain('RUN ABORTED')
      expect(digest.html).toContain('TypeError: boom')
      expect(digest.html).not.toContain('&lt;run-aborted&gt;')
    })

    it('shows a no-errors badge for apps that ran clean', (): void => {
      const digest = buildDigest({
        rows: [
          row({ app: 'ynab-categorize', transaction_id: 'a', patch_status: 'success' }),
          row({ app: 'ynab-enrich-memos', transaction_id: 'b', patch_status: 'error', error: 'x' }),
        ],
      })

      expect(digest.html).toContain('no errors')
      expect(digest.html).toContain('1 success')
    })

    it('renders each success with its payee and result summary', (): void => {
      const digest = buildDigest({
        rows: [
          row({
            patch_status: 'success',
            payee_name: 'Whole Foods',
            amount_dollars: -54.2,
            result_summary: 'Groceries',
          }),
        ],
      })

      expect(digest.html).toContain('Whole Foods')
      expect(digest.html).toContain('-$54.20')
      expect(digest.html).toContain('Groceries')
    })

    it('escapes HTML in a result summary', (): void => {
      const digest = buildDigest({
        rows: [row({ patch_status: 'success', result_summary: 'auto-gen: <b>x</b> & y' })],
      })

      expect(digest.html).toContain('auto-gen: &lt;b&gt;x&lt;/b&gt; &amp; y')
      expect(digest.html).not.toContain('<b>x</b>')
    })
  })
})
