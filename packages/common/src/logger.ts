import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import pino, { type Logger as PinoLogger } from 'pino'
import pinoPretty from 'pino-pretty'
import { z } from 'zod'
import { writeWithProgress } from './progress.js'

// `status` describes the categorization (or upstream) decision; `patch_status` describes
// what happened when (or whether) the row was PATCHed. Splitting them gives a single-
// field answer for "did this hit YNAB?" without overloading one column.
//
// `patch_status: 'skipped_for_upstream_error'` covers any pre-PATCH failure (categorize
// error, enrich-memos receipt-not-found, etc.) — read `status` for the cause.
export const auditEntrySchema = z.object({
  timestamp: z.string(),
  transaction_id: z.string(),
  payee_name: z.string().nullable(),
  memo: z.string().nullable(),
  amount_dollars: z.number(),
  chosen_category_id: z.string().nullable(),
  chosen_category_name: z.string().nullable(),
  prompt_tokens: z.number().optional(),
  latency_ms: z.number().optional(),
  status: z.enum(['ok', 'fallback', 'error']),
  patch_status: z.enum(['success', 'error', 'skipped_for_dry_run', 'skipped_for_upstream_error']),
  error: z.string().optional(),
})

export type AuditEntry = z.infer<typeof auditEntrySchema>

type LogParams = { msg: string; extra?: Record<string, unknown> }
type LoggerInit = { verbose: boolean; name: string; auditDir?: string }

export type Logger = {
  info: (params: LogParams) => void
  warn: (params: LogParams) => void
  error: (params: LogParams) => void
  debug: (params: LogParams) => void
  audit: (entry: AuditEntry) => void
}

// `name` is the audit-log filename prefix — `${name}-YYYY-MM-DD.jsonl`. Each app passes
// its own name so the categorize and enrich-memos audit streams don't share a file.
export function createLogger({
  verbose,
  name,
  auditDir = join(process.cwd(), 'audit'),
}: LoggerInit): Logger {
  const auditPath = join(auditDir, `${name}-${todayLocalIso()}.jsonl`)
  mkdirSync(dirname(auditPath), { recursive: true })

  // Pretty output for TTY (routed through the progress coordinator so logs interleave
  // cleanly with any active progress bar), raw JSON otherwise.
  const prettyStream = process.stdout.isTTY
    ? pinoPretty({
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        destination: new Writable({
          write(chunk, _encoding, callback) {
            writeWithProgress(chunk.toString())
            callback()
          },
        }),
      })
    : undefined
  const pinoLogger: PinoLogger = prettyStream
    ? pino({ level: verbose ? 'debug' : 'info' }, prettyStream)
    : pino({ level: verbose ? 'debug' : 'info' })

  function info({ msg, extra }: LogParams): void {
    if (extra) pinoLogger.info(extra, msg)
    else pinoLogger.info(msg)
  }

  function warn({ msg, extra }: LogParams): void {
    if (extra) pinoLogger.warn(extra, msg)
    else pinoLogger.warn(msg)
  }

  function error({ msg, extra }: LogParams): void {
    if (extra) pinoLogger.error(extra, msg)
    else pinoLogger.error(msg)
  }

  function debug({ msg, extra }: LogParams): void {
    if (extra) pinoLogger.debug(extra, msg)
    else pinoLogger.debug(msg)
  }

  function audit(entry: AuditEntry): void {
    const parsed = auditEntrySchema.safeParse(entry)
    if (!parsed.success) {
      pinoLogger.warn(
        { issues: parsed.error.issues, transaction_id: entry.transaction_id },
        'malformed audit entry — writing anyway',
      )
    }
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`)
  }

  return { info, warn, error, debug, audit }
}

// Local-date YYYY-MM-DD so the audit file rollover matches the user's wall clock.
function todayLocalIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')

  return `${y}-${m}-${day}`
}
