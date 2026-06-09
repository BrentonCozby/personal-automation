import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appAuditDir } from '@personal-automation/common/audit-path'
import { fatal } from '@personal-automation/common/cli'
import { isoDateNDaysAgo, todayIso } from '@personal-automation/common/date'
import { type EnrichMemosAudit, enrichMemosAuditSchema } from './enrich.js'

const DEFAULT_LOOKBACK_DAYS = 7

export type ReviewArgs = {
  /** Inclusive lower bound on the run date (audit filename date), YYYY-MM-DD. */
  since: string
  /** Inclusive upper bound on the run date, YYYY-MM-DD. */
  until: string
  /** When set, show at most this many rows, drawn at random from the matched set. */
  sample?: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  return DATE_RE.test(value)
}

function positiveInt({ value, flag }: { value: string | undefined; flag: string }): number {
  if (!value) throw new Error(`${flag} requires a number`)
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${flag} must be a positive integer (got ${value})`)

  return n
}

export function parseArgs(argv: string[]): ReviewArgs {
  let days = DEFAULT_LOOKBACK_DAYS
  let since: string | undefined
  let until: string | undefined
  let sample: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') {
      days = positiveInt({ value: argv[++i], flag: '--days' })
    } else if (a === '--since') {
      since = argv[++i]
      if (!since || !isIsoDate(since)) throw new Error('--since requires a YYYY-MM-DD date')
    } else if (a === '--until') {
      until = argv[++i]
      if (!until || !isIsoDate(until)) throw new Error('--until requires a YYYY-MM-DD date')
    } else if (a === '--sample') {
      sample = positiveInt({ value: argv[++i], flag: '--sample' })
    } else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }

  // --since/--until win when given; otherwise fall back to the rolling --days window.
  const resolvedSince = since ?? isoDateNDaysAgo(days)
  const resolvedUntil = until ?? todayIso()
  if (resolvedSince > resolvedUntil)
    throw new Error(`--since (${resolvedSince}) is after --until (${resolvedUntil})`)

  return { since: resolvedSince, until: resolvedUntil, ...(sample !== undefined && { sample }) }
}

function printHelp(): void {
  console.log(`Usage: tsx src/review.ts [options]

Renders the memos ynab-enrich-memos wrote, with each one's matched order total and a
link to the source Amazon email, so the model's output can be spot-checked.

Options:
  --days N            Review runs from the last N days (default ${DEFAULT_LOOKBACK_DAYS})
  --since YYYY-MM-DD   Inclusive start of the run-date range (overrides --days)
  --until YYYY-MM-DD   Inclusive end of the run-date range (default: today)
  --sample N           Show at most N rows, drawn at random
  --help, -h           Show this help`)
}

/**
 * Audit files whose run date (the YYYY-MM-DD in the filename) falls in [since, until], oldest
 * first. The enrich audit dir holds only this app's `…-<date>.jsonl` files, so matching the
 * trailing date is enough — no need to hardcode the app name.
 */
export function auditFilesInRange({
  auditDir,
  since,
  until,
}: {
  auditDir: string
  since: string
  until: string
}): string[] {
  if (!existsSync(auditDir)) return []

  return readdirSync(auditDir)
    .map(name => {
      const date = /-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1]

      return date ? { name, date } : null
    })
    .filter(
      (f): f is { name: string; date: string } => f !== null && f.date >= since && f.date <= until,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(f => join(auditDir, f.name))
}

/** Parse the given audit files and keep only the rows where a memo was written (`enriched`). */
export function readEnrichedRows(filePaths: string[]): EnrichMemosAudit[] {
  const rows: EnrichMemosAudit[] = []
  for (const filePath of filePaths) {
    const text = readFileSync(filePath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = enrichMemosAuditSchema.safeParse(raw)
      if (parsed.success && parsed.data.status === 'enriched') rows.push(parsed.data)
    }
  }

  return rows
}

/**
 * Collapse to one row per transaction, keeping the most recent. This looks redundant — a
 * transaction is normally enriched once — but the audit log is append-only across runs, so the
 * same transaction can have an `enriched` row from each run that processed it: a backfill that
 * was re-run, or repeated dry-runs (a dry-run never writes the memo, so the transaction stays
 * eligible and gets re-matched on the next run). Without this, such a transaction shows up once
 * per run in the review.
 */
export function dedupeByTransaction(rows: EnrichMemosAudit[]): EnrichMemosAudit[] {
  const latest = new Map<string, EnrichMemosAudit>()
  for (const row of rows) {
    const prev = latest.get(row.transaction_id)
    // ISO-8601 UTC timestamps sort lexicographically, so a string compare picks the newer row.
    if (!prev || row.timestamp > prev.timestamp) latest.set(row.transaction_id, row)
  }

  return [...latest.values()]
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = copy[i]
    const b = copy[j]
    // Both indices are in range; the guard only satisfies noUncheckedIndexedAccess.
    if (a === undefined || b === undefined) continue
    copy[i] = b
    copy[j] = a
  }

  return copy
}

/** A random subset of `n` rows (all of them, if there are `n` or fewer). RNG is injectable. */
export function sampleRows({
  rows,
  n,
  random = Math.random,
}: {
  rows: EnrichMemosAudit[]
  n: number
  random?: () => number
}): EnrichMemosAudit[] {
  if (n >= rows.length) return [...rows]

  return shuffle(rows, random).slice(0, n)
}

function formatAmount(dollars: number): string {
  const sign = dollars < 0 ? '-' : ''

  return `${sign}$${Math.abs(dollars).toFixed(2)}`
}

function formatRow(row: EnrichMemosAudit): string {
  const date = row.transaction_date ?? '(no date)'
  const total = row.order_total !== undefined ? `order total ${formatAmount(row.order_total)}` : ''
  const head = [date, formatAmount(row.amount_dollars), total].filter(Boolean).join('   ')

  const lines = [head, `  memo:   ${row.new_memo ?? '(none)'}`]
  const sourceParts = [
    ...(row.matched_email_subject ? [`"${row.matched_email_subject}"`] : []),
    ...(row.matched_email_date ? [row.matched_email_date] : []),
  ]
  if (sourceParts.length > 0) lines.push(`  source: ${sourceParts.join('  ·  ')}`)
  if (row.matched_email_url) lines.push(`  link:   ${row.matched_email_url}`)

  return lines.join('\n')
}

/** The full review report: a header line, then one block per row. Pure — no IO. */
export function formatReview({
  rows,
  since,
  until,
  total,
}: {
  rows: EnrichMemosAudit[]
  since: string
  until: string
  /** Matched-row count before sampling; when it differs from rows.length, sampling happened. */
  total: number
}): string {
  const range = since === until ? since : `${since} to ${until}`
  if (total === 0) return `Enrich-memos review — runs ${range}\nNo enriched transactions found.`

  const noun = total === 1 ? 'enriched transaction' : 'enriched transactions'
  const sampled = rows.length < total ? ` (showing ${rows.length} sampled)` : ''
  const header = `Enrich-memos review — runs ${range}\n${total} ${noun}${sampled}`

  // Sort the shown rows by the transaction's own date so the report reads chronologically.
  const ordered = [...rows].sort((a, b) =>
    (a.transaction_date ?? '').localeCompare(b.transaction_date ?? ''),
  )

  return [header, ...ordered.map(formatRow)].join('\n\n')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const auditDir = appAuditDir(import.meta.url)
  const files = auditFilesInRange({ auditDir, since: args.since, until: args.until })
  const rows = dedupeByTransaction(readEnrichedRows(files))
  const shown = args.sample !== undefined ? sampleRows({ rows, n: args.sample }) : rows

  console.log(
    formatReview({ rows: shown, since: args.since, until: args.until, total: rows.length }),
  )
}

try {
  main()
} catch (err) {
  fatal(err)
}
