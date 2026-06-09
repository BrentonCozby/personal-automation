import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EnrichMemosAudit } from './enrich.js'
import {
  auditFilesInRange,
  dedupeByTransaction,
  formatReview,
  parseArgs,
  readEnrichedRows,
  sampleRows,
} from './review.js'

function okRow(overrides: Partial<EnrichMemosAudit> = {}): EnrichMemosAudit {
  return {
    app: 'ynab-enrich-memos',
    timestamp: '2026-06-09T12:00:00.000Z',
    transaction_id: 't-1',
    payee_name: 'Amazon',
    memo: null,
    amount_dollars: -21.48,
    transaction_date: '2026-06-08',
    status: 'enriched',
    outcome: 'applied',
    new_memo: 'auto-gen: USB-C cable ($21.48) — Total $21.48',
    order_total: 21.48,
    matched_email_url: 'https://mail.google.com/mail/u/0/#all/m1',
    matched_email_subject: 'Your Amazon.com order',
    matched_email_date: 'Mon, 8 Jun 2026 10:00:00 -0700',
    ...overrides,
  }
}

describe('parseArgs', (): void => {
  it('defaults to a rolling 7-day window ending today', (): void => {
    const args = parseArgs([])

    expect(args.since <= args.until).toBe(true)
    expect(args.sample).toBeUndefined()
    expect(args.until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('honors explicit --since/--until and --sample', (): void => {
    const args = parseArgs(['--since', '2026-06-01', '--until', '2026-06-07', '--sample', '5'])

    expect(args).toEqual({ since: '2026-06-01', until: '2026-06-07', sample: 5 })
  })

  it('rejects a malformed date, a non-positive sample, and a reversed range', (): void => {
    expect(() => parseArgs(['--since', 'June 1'])).toThrow(/YYYY-MM-DD/)
    expect(() => parseArgs(['--sample', '0'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--since', '2026-06-10', '--until', '2026-06-01'])).toThrow(/after/)
  })
})

describe('auditFilesInRange + readEnrichedRows', (): void => {
  let dir: string

  beforeEach((): void => {
    dir = mkdtempSync(join(tmpdir(), 'enrich-review-'))
  })

  afterEach((): void => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(name: string, rows: Partial<EnrichMemosAudit>[]): void {
    writeFileSync(join(dir, name), rows.map(r => JSON.stringify(okRow(r))).join('\n'))
  }

  it('selects only files whose filename date is within the range, oldest first', (): void => {
    write('ynab-enrich-memos-2026-06-01.jsonl', [{}])
    write('ynab-enrich-memos-2026-06-05.jsonl', [{}])
    write('ynab-enrich-memos-2026-06-09.jsonl', [{}])
    // A stray non-audit file is ignored.
    writeFileSync(join(dir, 'notes.txt'), 'ignore me')

    const files = auditFilesInRange({ auditDir: dir, since: '2026-06-02', until: '2026-06-08' })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/2026-06-05\.jsonl$/)
  })

  it('returns an empty list when the audit dir does not exist', (): void => {
    expect(
      auditFilesInRange({ auditDir: join(dir, 'nope'), since: '2026-01-01', until: '2026-12-31' }),
    ).toEqual([])
  })

  it('keeps only enriched rows and skips blank or unparseable lines', (): void => {
    const path = join(dir, 'ynab-enrich-memos-2026-06-08.jsonl')
    const lines = [
      JSON.stringify(okRow({ transaction_id: 'ok-1' })),
      '',
      'not json',
      JSON.stringify(
        okRow({
          transaction_id: 'skip-1',
          status: 'no_receipt',
          outcome: 'skipped_for_no_match',
          new_memo: null,
        }),
      ),
      JSON.stringify(okRow({ transaction_id: 'ok-2' })),
    ]
    writeFileSync(path, lines.join('\n'))

    const rows = readEnrichedRows([path])

    expect(rows.map(r => r.transaction_id)).toEqual(['ok-1', 'ok-2'])
  })
})

describe('dedupeByTransaction', (): void => {
  it('keeps the most recent row per transaction id and leaves distinct ones alone', (): void => {
    const deduped = dedupeByTransaction([
      okRow({ transaction_id: 'a', timestamp: '2026-06-02T03:22:00.000Z', new_memo: 'old' }),
      okRow({ transaction_id: 'a', timestamp: '2026-06-02T03:52:00.000Z', new_memo: 'new' }),
      okRow({ transaction_id: 'b', timestamp: '2026-06-02T03:22:00.000Z' }),
    ])

    expect(deduped).toHaveLength(2)
    expect(deduped.find(r => r.transaction_id === 'a')?.new_memo).toBe('new')
  })
})

describe('sampleRows', (): void => {
  const rows = Array.from({ length: 5 }, (_unused, i) => okRow({ transaction_id: `t-${i}` }))

  it('returns every row when n is at least the row count', (): void => {
    expect(sampleRows({ rows, n: 5 })).toHaveLength(5)
    expect(sampleRows({ rows, n: 99 })).toHaveLength(5)
  })

  it('returns exactly n distinct rows when n is smaller', (): void => {
    const picked = sampleRows({ rows, n: 2, random: () => 0 })

    expect(picked).toHaveLength(2)
    expect(new Set(picked.map(r => r.transaction_id)).size).toBe(2)
  })
})

describe('formatReview', (): void => {
  it('renders a header and a block with amount, total, memo, source, and link', (): void => {
    const out = formatReview({
      rows: [okRow({})],
      since: '2026-06-08',
      until: '2026-06-08',
      total: 1,
    })

    expect(out).toContain('Enrich-memos review — runs 2026-06-08')
    expect(out).toContain('1 enriched transaction')
    expect(out).toContain('-$21.48')
    expect(out).toContain('order total $21.48')
    expect(out).toContain('memo:   auto-gen: USB-C cable ($21.48) — Total $21.48')
    expect(out).toContain('source: "Your Amazon.com order"  ·  Mon, 8 Jun 2026 10:00:00 -0700')
    expect(out).toContain('link:   https://mail.google.com/mail/u/0/#all/m1')
  })

  it('notes when the shown rows are a sample of a larger set', (): void => {
    const out = formatReview({
      rows: [okRow({})],
      since: '2026-06-01',
      until: '2026-06-09',
      total: 9,
    })

    expect(out).toContain('9 enriched transactions (showing 1 sampled)')
    expect(out).toContain('2026-06-01 to 2026-06-09')
  })

  it('reports an empty range without crashing', (): void => {
    const out = formatReview({ rows: [], since: '2026-06-01', until: '2026-06-09', total: 0 })

    expect(out).toContain('No enriched transactions found.')
  })

  it('gracefully omits source/link/total for an older row missing the new fields', (): void => {
    const out = formatReview({
      rows: [
        okRow({
          order_total: undefined,
          matched_email_url: undefined,
          matched_email_subject: undefined,
          matched_email_date: undefined,
        }),
      ],
      since: '2026-06-08',
      until: '2026-06-08',
      total: 1,
    })

    expect(out).toContain('memo:')
    expect(out).not.toContain('order total')
    expect(out).not.toContain('source:')
    expect(out).not.toContain('link:')
  })
})
