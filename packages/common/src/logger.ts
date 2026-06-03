import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import pino, { type Logger as PinoLogger } from 'pino'
import pinoPretty from 'pino-pretty'
import { z } from 'zod'
import { todayLocalIso } from './date.js'
import { writeWithProgress } from './progress.js'

// Fields every app's audit entry must include. Each app spreads `baseAuditFields` into its
// own Zod schema and adds app-specific fields (status, etc.). Common doesn't enumerate
// apps — the per-app schema is the source of truth, passed to `createLogger` for write-time
// validation.
//
// patch_status values, and how notify's digest treats each:
//   success                    — PATCH applied (counts as a success)
//   error                      — PATCH attempted and failed (counts as a digest error)
//   skipped_for_upstream_error — a failure before PATCH, so none was attempted; counts as a
//                                digest error (e.g. ynab-categorize's LLM call threw)
//   skipped_for_dry_run        — dry run, no PATCH (excluded from digest counts)
//   skipped_for_no_match       — ran fine, nothing to act on, not a failure; excluded from
//                                digest counts (e.g. ynab-enrich-memos found no matching receipt)
// Read your app's own `status` field for the specific cause.
export const baseAuditFields = {
  timestamp: z.string(),
  transaction_id: z.string(),
  payee_name: z.string().nullable(),
  memo: z.string().nullable(),
  amount_dollars: z.number(),
  patch_status: z.enum([
    'success',
    'error',
    'skipped_for_dry_run',
    'skipped_for_upstream_error',
    'skipped_for_no_match',
  ]),
  prompt_tokens: z.number().optional(),
  latency_ms: z.number().optional(),
  error: z.string().optional(),
}

export const baseAuditSchema = z.object(baseAuditFields)
export type BaseAudit = z.infer<typeof baseAuditSchema>
export type PatchStatus = BaseAudit['patch_status']

// Reserved transaction_id marking a run-level abort, not a real transaction. Producers
// write it when a run dies before processing entities; the notify digest renders it as a
// run-level failure. Shared so producer and consumer can't drift.
export const RUN_ABORTED_SENTINEL = '<run-aborted>'

type LogParams = { msg: string; extra?: Record<string, unknown> }

export type Logger<TAudit extends BaseAudit> = {
  info: (params: LogParams) => void
  warn: (params: LogParams) => void
  error: (params: LogParams) => void
  debug: (params: LogParams) => void
  audit: (entry: TAudit) => void
}

export function createLogger<TAudit extends BaseAudit>({
  verbose,
  name,
  auditSchema,
  auditDir = join(process.cwd(), 'audit'),
}: {
  verbose: boolean
  name: string
  auditSchema: z.ZodType<TAudit>
  auditDir?: string
}): Logger<TAudit> {
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

  function audit(entry: TAudit): void {
    const parsed = auditSchema.safeParse(entry)
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
