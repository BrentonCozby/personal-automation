import { type PatchStatus, RUN_ABORTED_SENTINEL } from '@personal-automation/common/logger'
import { SUBJECT_PREFIX } from './constants.js'

export type AuditRow = {
  app: string
  transaction_id: string
  payee_name: string | null
  amount_dollars: number
  patch_status: PatchStatus
  error?: string
  /** The transaction's memo — the input ynab-categorize used to pick a category. */
  memo?: string | null
  /** The transaction's own date (YYYY-MM-DD). */
  transaction_date?: string | null
  /** What the run did to this transaction (category assigned, memo written), for success rows. */
  result_summary?: string | null
}

export type Digest = {
  errorCount: number
  successCount: number
  subject: string
  /** Plain-text body. The fallback part of the multipart/alternative email. */
  body: string
  /** HTML body. The part mail clients prefer where they can render it. */
  html: string
}

type AppBucket = {
  errors: AuditRow[]
  successes: AuditRow[]
}

export function buildDigest({ rows }: { rows: AuditRow[] }): Digest {
  const byApp = new Map<string, AppBucket>()
  for (const row of rows) {
    let bucket = byApp.get(row.app)
    if (!bucket) {
      bucket = { errors: [], successes: [] }
      byApp.set(row.app, bucket)
    }
    if (row.patch_status === 'error' || row.patch_status === 'skipped_for_upstream_error') {
      bucket.errors.push(row)
    } else if (row.patch_status === 'success') {
      bucket.successes.push(row)
    }
    // skipped_for_dry_run and skipped_for_no_match are excluded from both groups by design.
  }

  const errorCount = [...byApp.values()].reduce((sum, b) => sum + b.errors.length, 0)
  const successCount = [...byApp.values()].reduce((sum, b) => sum + b.successes.length, 0)
  const subject = `${SUBJECT_PREFIX} — ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`
  const body = renderBody({ byApp })
  const html = renderHtml({ byApp, errorCount })

  return { errorCount, successCount, subject, body, html }
}

function renderBody({ byApp }: { byApp: Map<string, AppBucket> }): string {
  // Stable order so the email reads the same day-to-day.
  const sortedApps = [...byApp.keys()].sort()
  const sections = sortedApps.map(app => {
    const bucket = byApp.get(app)
    if (!bucket) return ''

    return renderSection({ app, bucket })
  })

  return sections.filter(s => s.length > 0).join('\n\n')
}

function renderSection({ app, bucket }: { app: string; bucket: AppBucket }): string {
  const errorCount = bucket.errors.length
  const successCount = bucket.successes.length
  const header = `${app} — ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}, ${successCount} ${successCount === 1 ? 'success' : 'successes'}`
  const rule = '═'.repeat([...header].length)

  const blocks: string[] = []
  if (errorCount > 0) blocks.push(bucket.errors.map(row => renderRow({ row })).join('\n\n'))
  if (successCount > 0) {
    const lines = bucket.successes.map(row => renderSuccessRow({ row }))

    blocks.push(['  Successes:', ...lines].join('\n'))
  }
  // Surfaces the app even when nothing happened, so the digest reads as "everything that
  // ran, here's what happened" rather than only the broken parts.
  if (blocks.length === 0) blocks.push('  (nothing to report)')

  return `${header}\n${rule}\n\n${blocks.join('\n\n')}`
}

function renderRow({ row }: { row: AuditRow }): string {
  if (row.transaction_id === RUN_ABORTED_SENTINEL) {
    const reason = row.error ?? '(no error message recorded)'

    return [`  RUN ABORTED`, `    Reason:  ${reason}`].join('\n')
  }

  const payee = row.payee_name ?? '(no payee)'
  const reason = row.error ?? '(no error message recorded)'
  const date = formatDate(row.transaction_date)

  return [
    `  Transaction ${row.transaction_id}`,
    ...(date ? [`    Date:    ${date}`] : []),
    `    Payee:   ${payee}`,
    `    Amount:  ${formatAmount(row.amount_dollars)}`,
    `    Status:  ${row.patch_status}`,
    `    Reason:  ${reason}`,
  ].join('\n')
}

// A few lines per applied transaction: payee/amount/date, the memo the decision used (for
// ynab-categorize), and what the run produced — enough to eyeball that the category / memo
// looks right.
function renderSuccessRow({ row }: { row: AuditRow }): string {
  const payee = row.payee_name ?? '(no payee)'
  const summary = row.result_summary || '(applied)'
  const date = formatDate(row.transaction_date)

  const lines = [`    ${payee}  ${formatAmount(row.amount_dollars)}${date ? `  ${date}` : ''}`]
  if (row.memo) lines.push(`      memo: ${row.memo}`)
  lines.push(`      →  ${summary}`)

  return lines.join('\n')
}

// Font stacks shared across every inline style. System fonts only — email clients can't load
// web fonts reliably, so we lean on what the OS already has.
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

// Small uppercase field label ("TRANSACTION", "REASON"). Reused so the labels stay identical.
const MINI_LABEL =
  'font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:#9ca3af; font-weight:600;'

function renderHtml({
  byApp,
  errorCount,
}: {
  byApp: Map<string, AppBucket>
  errorCount: number
}): string {
  // Same stable alphabetical order as the text body.
  const sortedApps = [...byApp.keys()].sort()
  const sections = sortedApps
    .map(app => {
      const bucket = byApp.get(app)

      return bucket ? renderHtmlSection({ app, bucket }) : ''
    })
    .filter(s => s.length > 0)
    .join('')

  const headerPill =
    errorCount === 0
      ? pill({ text: 'All clear', tone: 'ok' })
      : pill({ text: `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`, tone: 'error' })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0; padding:0; background-color:#ffffff; font-family:${SANS}; -webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="left" style="padding:24px 24px 32px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" align="left" style="width:100%; max-width:600px;">
<tr><td>
<div style="font-size:12px; letter-spacing:0.1em; text-transform:uppercase; color:#9ca3af; font-weight:700;">${escapeHtml(SUBJECT_PREFIX)}</div>
<div style="font-size:22px; font-weight:800; color:#111827; margin-top:6px;">Daily run digest ${headerPill}</div>
${sections}
<div style="margin-top:30px; border-top:1px solid #eceef1; padding-top:16px; font-size:12px; color:#9ca3af;">Built from today’s audit logs.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

function renderHtmlSection({ app, bucket }: { app: string; bucket: AppBucket }): string {
  const errorCount = bucket.errors.length
  const successCount = bucket.successes.length
  const successText = `${successCount} ${successCount === 1 ? 'success' : 'successes'}`
  const sectionPill =
    errorCount === 0
      ? pill({ text: 'no errors', tone: 'ok' })
      : pill({ text: `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`, tone: 'error' })

  const header = `
<div style="margin-top:28px; border-top:1px solid #eceef1; padding-top:22px;">
<div style="font-size:16px; font-weight:700; color:#111827; line-height:1.4;">${escapeHtml(app)}${sectionPill}</div>
<div style="font-size:13px; color:#6b7280; margin-top:4px;">${successText}</div>
</div>`

  const errors = bucket.errors.map(row => renderHtmlRow({ row })).join('')

  let successes = ''
  if (successCount > 0) {
    const items = bucket.successes.map(row => renderHtmlSuccess({ row })).join('')
    const label =
      errorCount > 0 ? `<div style="${MINI_LABEL} margin-top:18px;">Successes</div>` : ''
    successes = `${label}${items}`
  }

  const empty =
    errorCount === 0 && successCount === 0
      ? '<div style="margin-top:12px; font-size:14px; color:#9ca3af;">Nothing to report.</div>'
      : ''

  return `${header}${errors}${successes}${empty}`
}

function renderHtmlRow({ row }: { row: AuditRow }): string {
  const reason = row.error ?? '(no error message recorded)'

  if (row.transaction_id === RUN_ABORTED_SENTINEL) {
    return `
<div style="margin-top:14px; border:1px solid #fecaca; border-radius:10px; overflow:hidden;">
<div style="background:#fef2f2; padding:10px 14px; border-bottom:1px solid #fee2e2;">
<span style="font-size:13px; font-weight:700; color:#b91c1c; letter-spacing:0.04em;">RUN ABORTED</span>
</div>
<div style="padding:4px 14px 14px 14px;">${reasonBlock({ reason })}</div>
</div>`
  }

  const payee = row.payee_name ?? '(no payee)'
  const date = formatDate(row.transaction_date)

  return `
<div style="margin-top:14px; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
<div style="background:#fafafa; padding:10px 14px; border-bottom:1px solid #eceef1;">
<div style="${MINI_LABEL} margin-bottom:2px;">Transaction</div>
<div style="font-family:${MONO}; font-size:13px; color:#374151; word-break:break-all;">${escapeHtml(row.transaction_id)}</div>
</div>
<div style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
${date ? fieldRow({ label: 'Date', valueHtml: escapeHtml(date) }) : ''}
${fieldRow({ label: 'Payee', valueHtml: escapeHtml(payee) })}
${fieldRow({ label: 'Amount', valueHtml: escapeHtml(formatAmount(row.amount_dollars)) })}
${fieldRow({ label: 'Status', valueHtml: statusText(row.patch_status) })}
</table>
${reasonBlock({ reason })}
</div>
</div>`
}

// A light row per applied transaction — green left accent (vs the bordered red cards for
// errors). Line 1 is payee · amount · date; for ynab-categorize the memo the decision used
// follows, then the outcome (category, or the memo written for ynab-enrich-memos) — enough to
// check at a glance that the result fits.
function renderHtmlSuccess({ row }: { row: AuditRow }): string {
  const payee = row.payee_name ?? '(no payee)'
  const summary = row.result_summary || '(applied)'
  const date = formatDate(row.transaction_date)

  const meta = [escapeHtml(formatAmount(row.amount_dollars)), ...(date ? [escapeHtml(date)] : [])]
    .map(part => `<span style="color:#9ca3af;"> · ${part}</span>`)
    .join('')
  const memo = row.memo
    ? `<div style="font-size:13px; color:#6b7280; margin-top:3px; word-break:break-word;">memo: ${escapeHtml(row.memo)}</div>`
    : ''

  return `
<div style="margin-top:10px; border-left:3px solid #22c55e; background:#f6fef9; border-radius:0 8px 8px 0; padding:9px 14px;">
<div style="font-size:14px; color:#111827; line-height:1.45;"><span style="font-weight:600;">${escapeHtml(payee)}</span>${meta}</div>
${memo}
<div style="font-size:13.5px; color:#1f2937; margin-top:3px; word-break:break-word;">${escapeHtml(summary)}</div>
</div>`
}

function fieldRow({ label, valueHtml }: { label: string; valueHtml: string }): string {
  return `<tr><td style="padding:3px 12px 3px 0; color:#6b7280; width:84px; vertical-align:top; font-size:14px;">${label}</td><td style="padding:3px 0; color:#111827; font-size:14px; line-height:1.45;">${valueHtml}</td></tr>`
}

// The error message, in a red-tinted monospace block. pre-wrap keeps the line breaks of a
// multi-line error (e.g. a JSON OAuth response) and wraps long lines instead of overflowing.
function reasonBlock({ reason }: { reason: string }): string {
  return `<div style="margin-top:12px;">
<div style="${MINI_LABEL} margin-bottom:6px;">Reason</div>
<div style="font-family:${MONO}; font-size:12.5px; line-height:1.55; color:#991b1b; background:#fef2f2; border:1px solid #fee2e2; border-radius:8px; padding:10px 12px; white-space:pre-wrap; word-break:break-word;">${escapeHtml(reason)}</div>
</div>`
}

// skipped_for_upstream_error is a skip caused by an upstream failure — amber, distinct from a
// hard error in red. Both are the only statuses that reach an error row.
function statusText(status: PatchStatus): string {
  const color = status === 'skipped_for_upstream_error' ? '#b45309' : '#b91c1c'

  return `<span style="font-family:${MONO}; font-size:13px; color:${color}; word-break:break-word;">${escapeHtml(status)}</span>`
}

function pill({ text, tone }: { text: string; tone: 'ok' | 'error' }): string {
  const bg = tone === 'ok' ? '#f0fdf4' : '#fef2f2'
  const fg = tone === 'ok' ? '#15803d' : '#b91c1c'

  return `<span style="display:inline-block; margin-left:8px; padding:2px 9px; border-radius:999px; background:${bg}; color:${fg}; font-size:12px; font-weight:600; vertical-align:middle;">${escapeHtml(text)}</span>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// amount_dollars is already in dollars in the audit schema, while the only existing
// helper (`formatDollars` in @personal-automation/ynab/milliunits) takes milliunits. A
// 3-line inline format is cleaner than round-tripping × 1000 just to reuse it.
function formatAmount(dollars: number): string {
  const sign = dollars < 0 ? '-' : ''

  return `${sign}$${Math.abs(dollars).toFixed(2)}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Formats a YNAB date ("2026-06-03") as "Jun 3, 2026". Parses the parts by hand rather than
// via `new Date()`, which would shift the day across time zones. Returns null when absent, or
// the raw value if it isn't the expected YYYY-MM-DD shape.
function formatDate(date: string | null | undefined): string | null {
  if (!date) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  const month = MONTHS[Number(match[2]) - 1]
  if (!month) return date

  return `${month} ${Number(match[3])}, ${match[1]}`
}
