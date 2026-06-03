import { type PatchStatus, RUN_ABORTED_SENTINEL } from '@personal-automation/common/logger'
import { SUBJECT_PREFIX } from './constants.js'

export type AuditRow = {
  app: string
  transaction_id: string
  payee_name: string | null
  amount_dollars: number
  patch_status: PatchStatus
  error?: string
}

export type Digest = {
  errorCount: number
  subject: string
  body: string
}

type AppBucket = {
  errors: AuditRow[]
  successCount: number
}

export function buildDigest({ rows }: { rows: AuditRow[] }): Digest {
  const byApp = new Map<string, AppBucket>()
  for (const row of rows) {
    let bucket = byApp.get(row.app)
    if (!bucket) {
      bucket = { errors: [], successCount: 0 }
      byApp.set(row.app, bucket)
    }
    if (row.patch_status === 'error' || row.patch_status === 'skipped_for_upstream_error') {
      bucket.errors.push(row)
    } else if (row.patch_status === 'success') {
      bucket.successCount += 1
    }
    // skipped_for_dry_run and skipped_for_no_match are excluded from both counts by design.
  }

  const errorCount = [...byApp.values()].reduce((sum, b) => sum + b.errors.length, 0)
  const subject = `${SUBJECT_PREFIX} — ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`
  const body = renderBody({ byApp })

  return { errorCount, subject, body }
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
  const header = `${app} — ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}, ${bucket.successCount} ${bucket.successCount === 1 ? 'success' : 'successes'}`
  const rule = '═'.repeat([...header].length)

  if (errorCount === 0) {
    // Surfaces the app in the email even on a clean run, so the digest reads as
    // "everything that ran, here's what happened" rather than only the broken parts.
    return `${header}\n${rule}\n\n  (no errors)`
  }

  const rowBlocks = bucket.errors.map(row => renderRow({ row }))

  return `${header}\n${rule}\n\n${rowBlocks.join('\n\n')}`
}

function renderRow({ row }: { row: AuditRow }): string {
  if (row.transaction_id === RUN_ABORTED_SENTINEL) {
    const reason = row.error ?? '(no error message recorded)'

    return [`  RUN ABORTED`, `    Reason:  ${reason}`].join('\n')
  }

  const payee = row.payee_name ?? '(no payee)'
  const reason = row.error ?? '(no error message recorded)'

  return [
    `  Transaction ${row.transaction_id}`,
    `    Payee:   ${payee}`,
    `    Amount:  ${formatAmount(row.amount_dollars)}`,
    `    Status:  ${row.patch_status}`,
    `    Reason:  ${reason}`,
  ].join('\n')
}

// amount_dollars is already in dollars in the audit schema, while the only existing
// helper (`formatDollars` in @personal-automation/ynab/milliunits) takes milliunits. A
// 3-line inline format is cleaner than round-tripping × 1000 just to reuse it.
function formatAmount(dollars: number): string {
  const sign = dollars < 0 ? '-' : ''

  return `${sign}$${Math.abs(dollars).toFixed(2)}`
}
