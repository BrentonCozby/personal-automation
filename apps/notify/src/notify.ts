import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_DIR_NAME, auditFileName } from '@personal-automation/common/audit-path'
import { baseAuditSchema } from '@personal-automation/common/logger'
import { createGmailAuth } from '@personal-automation/gmail/auth'
import { createGmailClient } from '@personal-automation/gmail/client'
import pino from 'pino'
import type { Config } from './config.js'
import { SELF_APP_NAME } from './constants.js'
import { type AuditRow, buildDigest } from './digest.js'

type RunOptions = {
  config: Config
  today: string
  appsDir: string
}

export type RunResult =
  | { kind: 'no_activity'; rowsRead: number }
  | { kind: 'sent'; errorCount: number; messageId: string }

export async function runNotify({ config, today, appsDir }: RunOptions): Promise<RunResult> {
  const logger = pino({ level: 'info' })

  const rows = collectAuditRows({ appsDir, today, logger })
  const digest = buildDigest({ rows })

  // Send a digest whenever the run did something — errors or successes — so the email doubles
  // as a daily check that categorization and memo-enrichment are still working. Skip only when
  // nothing was applied (an empty run, or one with only skips).
  if (digest.errorCount === 0 && digest.successCount === 0) {
    logger.info({ rowsRead: rows.length }, 'No activity in today’s audit logs; skipping email.')

    return { kind: 'no_activity', rowsRead: rows.length }
  }

  const auth = createGmailAuth({
    clientId: config.gmailClientId,
    clientSecret: config.gmailClientSecret,
    refreshToken: config.gmailRefreshToken,
  })
  const gmail = createGmailClient({ auth })
  const sent = await gmail.sendMessage({
    to: config.toEmail,
    subject: digest.subject,
    body: digest.body,
    html: digest.html,
  })

  logger.info(
    { errorCount: digest.errorCount, messageId: sent.id, to: config.toEmail },
    'Digest sent.',
  )

  return { kind: 'sent', errorCount: digest.errorCount, messageId: sent.id }
}

function collectAuditRows({
  appsDir,
  today,
  logger,
}: {
  appsDir: string
  today: string
  logger: pino.Logger
}): AuditRow[] {
  if (!existsSync(appsDir)) {
    logger.warn({ appsDir }, 'apps dir does not exist; nothing to read.')

    return []
  }
  const appNames = readdirSync(appsDir).filter(name => {
    const full = join(appsDir, name)

    return safeIsDirectory(full)
  })

  // The audit layout is the shared contract (audit-path): each app writes
  // apps/<app>/audit/<app>-<today>.jsonl, so notify reads exactly that path per app.
  const rows: AuditRow[] = []
  for (const appName of appNames) {
    if (appName === SELF_APP_NAME) continue
    const filePath = join(
      appsDir,
      appName,
      AUDIT_DIR_NAME,
      auditFileName({ app: appName, date: today }),
    )
    if (!existsSync(filePath)) continue

    rows.push(...readJsonlRows({ filePath, app: appName, logger }))
  }

  return rows
}

function readJsonlRows({
  filePath,
  app,
  logger,
}: {
  filePath: string
  app: string
  logger: pino.Logger
}): AuditRow[] {
  const text = readFileSync(filePath, 'utf8')
  const out: AuditRow[] = []
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo += 1
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      logger.warn({ filePath, lineNo }, 'audit line is not valid JSON; skipping.')
      continue
    }
    const parsed = baseAuditSchema.safeParse(raw)
    if (!parsed.success) {
      logger.warn(
        { filePath, lineNo, issues: parsed.error.issues },
        'audit line does not match baseAuditSchema; skipping.',
      )
      continue
    }
    out.push({
      app,
      transaction_id: parsed.data.transaction_id,
      payee_name: parsed.data.payee_name,
      amount_dollars: parsed.data.amount_dollars,
      patch_status: parsed.data.patch_status,
      memo: parsed.data.memo,
      transaction_date: parsed.data.transaction_date ?? null,
      result_summary: parsed.data.result_summary ?? null,
      ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
    })
  }

  return out
}

function safeIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
