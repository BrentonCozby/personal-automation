import { chunks } from '@personal-automation/common/chunks'
import { isoDateNDaysAgo } from '@personal-automation/common/date'
import { AppError, formatError, YnabApiError } from '@personal-automation/common/errors'
import {
  baseAuditFields,
  createLogger,
  type Logger,
  RUN_ABORTED_SENTINEL,
} from '@personal-automation/common/logger'
import { createProgress } from '@personal-automation/common/progress'
import { createGmailAuth } from '@personal-automation/gmail/auth'
import { createGmailClient, type GmailClient } from '@personal-automation/gmail/client'
import {
  createYnabClient,
  type PatchTransactionsResult,
  type YnabClient,
} from '@personal-automation/ynab/client'
import { milliunitsToDollars } from '@personal-automation/ynab/milliunits'
import type { Transaction, TransactionPatch } from '@personal-automation/ynab/types'
import pLimit from 'p-limit'
import { z } from 'zod'
import {
  type AnthropicEnrichClient,
  AnthropicError,
  createEnrichClient,
} from './anthropic/client.js'
import { buildEnrichPrompt } from './anthropic/prompts.js'
import type { Config } from './config.js'
import {
  ENRICH_CONCURRENCY,
  MAX_EMAILS_PER_TXN,
  ORDER_TOTAL_TOLERANCE_DOLLARS,
  PATCH_BATCH_SIZE,
  PAYEE_FILTER,
  PROGRESS_LOG_EVERY,
} from './constants.js'
import { buildReceiptQuery } from './gmail/query.js'
import { buildMemo } from './memo.js'
import { isAuthentic } from './trust.js'

export const enrichMemosAuditSchema = z.object({
  ...baseAuditFields,
  app: z.literal('ynab-enrich-memos'),
  status: z.enum(['ok', 'no_emails', 'no_receipt', 'error']),
  /** Trusted candidate receipt emails handed to the model (after dropping DMARC failures). */
  emails_found: z.number().optional(),
  /** True when the date-window query hit the fetch cap, so more emails may exist than were read. */
  emails_capped: z.boolean().optional(),
  /** Candidates dropped because they failed DMARC authentication (likely forged senders). */
  untrusted_dropped: z.number().optional(),
  /** The memo written (prefix included), or null when nothing was written. */
  new_memo: z.string().nullable().optional(),
})
export type EnrichMemosAudit = z.infer<typeof enrichMemosAuditSchema>

export type RunOptions = {
  dryRun: boolean
  verbose: boolean
  lookbackDays?: number
}

export type RunResult = {
  /** Memos written (in dry-run, would-be-written). */
  succeeded: number
  /** Gmail / Anthropic / PATCH failures. */
  failed: number
  /** Transactions left unchanged on purpose (no candidate email, or no matching receipt). */
  skipped: number
}

// Enrich fills in everything but `patch_status`; the persistence stage (or dry-run loop) sets it.
type AuditCore = Omit<EnrichMemosAudit, 'patch_status'>

// A transaction that produced a memo to PATCH.
type PatchOutcome = { patch: TransactionPatch; auditCore: AuditCore }

// A per-transaction result: either a memo to PATCH, or a deliberate skip already shaped as an
// audit row (no email found, or no receipt matched).
type EnrichOutcome = ({ kind: 'patch' } & PatchOutcome) | { kind: 'skip'; auditCore: AuditCore }

export async function runEnrich({
  config,
  opts,
  // Injectable for tests; defaults to the real audit logger.
  logger = createLogger({
    verbose: opts.verbose,
    name: 'ynab-enrich-memos',
    auditSchema: enrichMemosAuditSchema,
    auditDir: config.auditDir,
  }),
}: {
  config: Config
  opts: RunOptions
  logger?: Logger<EnrichMemosAudit>
}): Promise<RunResult> {
  try {
    return await runEnrichInner({ config, opts, logger })
  } catch (err) {
    // Surface fatal aborts in the audit log so the notify digest emails them. Guard the write:
    // if appendFileSync itself fails, don't let that replace the real cause. logger.error goes
    // to a different sink (pino/stderr) than the audit file, so it still works here.
    try {
      logger.audit(buildRunAbortedAuditEntry(err))
    } catch (auditErr) {
      logger.error({
        msg: 'Failed to write run-aborted audit entry',
        extra: { error: formatError(auditErr) },
      })
    }
    throw err
  }
}

async function runEnrichInner({
  config,
  opts,
  logger,
}: {
  config: Config
  opts: RunOptions
  logger: Logger<EnrichMemosAudit>
}): Promise<RunResult> {
  const ynab = createYnabClient({ token: config.ynabToken, budgetId: config.budgetId })
  const gmail = createGmailClient({
    auth: createGmailAuth({
      clientId: config.gmailClientId,
      clientSecret: config.gmailClientSecret,
      refreshToken: config.gmailRefreshToken,
    }),
  })
  const llm = createEnrichClient({ apiKey: config.anthropicApiKey, model: config.anthropicModel })

  const spinnersEnabled = process.stdout.isTTY === true
  const lookback = opts.lookbackDays || config.lookbackDays
  const sinceDate = isoDateNDaysAgo(lookback)

  logger.info({
    msg: 'Starting enrich run',
    extra: {
      budget_id: config.budgetId,
      since_date: sinceDate,
      lookback_days: lookback,
      dry_run: opts.dryRun,
    },
  })

  const loadProgress = createProgress({ enabled: spinnersEnabled, label: 'Loading transactions…' })
  const transactions = await ynab.getTransactionsForAccounts({
    accountIds: config.allowedAccountIds,
    sinceDate,
  })
  loadProgress.succeed(`Loaded ${transactions.length} transactions`)

  const eligible = transactions.filter(txn =>
    isEligible({ txn, allowedAccountIds: config.allowedAccountIds }),
  )
  logger.info({
    msg: 'Eligible transactions',
    extra: { total: transactions.length, eligible: eligible.length },
  })

  if (eligible.length === 0) {
    logger.info({ msg: 'Nothing to do.' })

    return { succeeded: 0, failed: 0, skipped: 0 }
  }

  const enrichProgress = createProgress({
    enabled: spinnersEnabled,
    label: 'Enriching',
    total: eligible.length,
  })
  let done = 0
  let lastLogged = 0

  const outcomes = await enrichAll({
    eligible,
    config,
    gmail,
    llm,
    logger,
    onProgress: () => {
      done++
      enrichProgress.tick()
      if (
        !spinnersEnabled &&
        (done - lastLogged >= PROGRESS_LOG_EVERY || done === eligible.length)
      ) {
        logger.info({ msg: 'Enrich progress', extra: { done, total: eligible.length } })
        lastLogged = done
      }
    },
  })
  enrichProgress.succeed(
    `Processed ${eligible.length} transactions` +
      (outcomes.enrichFailed > 0 ? ` (${outcomes.enrichFailed} failed)` : ''),
  )

  if (opts.dryRun) {
    for (const o of outcomes.successes) {
      logger.audit({ ...o.auditCore, patch_status: 'skipped_for_dry_run' })
    }
    logger.info({ msg: 'Dry run — skipping PATCH', extra: { proposed: outcomes.successes.length } })

    return {
      succeeded: outcomes.successes.length,
      failed: outcomes.enrichFailed,
      skipped: outcomes.skipped,
    }
  }

  const patchResult = await patchInBatches({ outcomes: outcomes.successes, ynab, logger })

  logger.info({
    msg: 'Done',
    extra: {
      succeeded: patchResult.succeeded,
      enrich_failed: outcomes.enrichFailed,
      patch_failed: patchResult.failed,
      skipped: outcomes.skipped,
    },
  })

  return {
    succeeded: patchResult.succeeded,
    failed: outcomes.enrichFailed + patchResult.failed,
    skipped: outcomes.skipped,
  }
}

export async function enrichAll({
  eligible,
  config,
  gmail,
  llm,
  logger,
  onProgress,
}: {
  eligible: Transaction[]
  config: Config
  gmail: GmailClient
  llm: AnthropicEnrichClient
  logger: Logger<EnrichMemosAudit>
  onProgress?: () => void
}): Promise<{ successes: PatchOutcome[]; enrichFailed: number; skipped: number }> {
  const limit = pLimit(ENRICH_CONCURRENCY)
  const settled = await Promise.allSettled(
    eligible.map(txn =>
      limit(async () => {
        try {
          return await enrichOne({ txn, config, gmail, llm, logger })
        } finally {
          onProgress?.()
        }
      }),
    ),
  )

  const successes: PatchOutcome[] = []
  let enrichFailed = 0
  let skipped = 0
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const txn = eligible[i]
    if (!result || !txn) continue
    if (result.status === 'fulfilled') {
      if (result.value.kind === 'patch') {
        successes.push({ patch: result.value.patch, auditCore: result.value.auditCore })
      } else {
        // A benign skip (no candidate email, or no receipt matched): nothing to PATCH and not a
        // failure, so audit it now with skipped_for_no_match — notify's digest won't flag it.
        skipped += 1
        logger.audit({ ...result.value.auditCore, patch_status: 'skipped_for_no_match' })
      }
      continue
    }
    // Gmail failures are AppError, Anthropic failures are AnthropicError. Anything else is a
    // programmer bug or genuinely unexpected — let it crash the run.
    if (!(result.reason instanceof AppError) && !(result.reason instanceof AnthropicError)) {
      throw result.reason
    }
    enrichFailed += 1
    logger.error({ msg: `Enrich failed for ${txn.id}`, extra: { error: result.reason.message } })
    logger.audit({
      ...buildAuditEntry({ txn, status: 'error', extra: { error: result.reason.message } }),
      patch_status: 'skipped_for_upstream_error',
    })
  }

  return { successes, enrichFailed, skipped }
}

async function enrichOne({
  txn,
  config,
  gmail,
  llm,
  logger,
}: {
  txn: Transaction
  config: Config
  gmail: GmailClient
  llm: AnthropicEnrichClient
  logger: Logger<EnrichMemosAudit>
}): Promise<EnrichOutcome> {
  const amount = Math.abs(milliunitsToDollars(txn.amount))
  const query = buildReceiptQuery({
    fromAddresses: config.fromFilter,
    txnDate: txn.date,
    windowDays: config.receiptWindowDays,
  })

  const refs = await gmail.listMessages({ query, maxResults: MAX_EMAILS_PER_TXN })
  if (refs.length === 0) {
    return {
      kind: 'skip',
      auditCore: buildAuditEntry({
        txn,
        status: 'no_emails',
        extra: { emails_found: 0, new_memo: null },
      }),
    }
  }

  // Newest-first results capped at MAX_EMAILS_PER_TXN: hitting the cap means the matching
  // receipt could be just outside what we fetched. Surface it in the audit row (durable) and a
  // warn (console), so a silently-dropped match is visible after the fact.
  const capped = refs.length === MAX_EMAILS_PER_TXN
  if (capped) {
    logger.warn({
      msg: 'Receipt-candidate query hit the fetch cap; more emails may exist in the window',
      extra: { txn: txn.id, cap: MAX_EMAILS_PER_TXN },
    })
  }

  const fetched = await Promise.all(refs.map(ref => gmail.getMessage({ id: ref.id })))
  // Drop candidates that failed DMARC (likely forged "Amazon" senders); fail open otherwise.
  const messages = fetched.filter(m => isAuthentic(m.authenticationResults))
  const untrustedDropped = fetched.length - messages.length
  if (untrustedDropped > 0) {
    logger.warn({
      msg: 'Dropped candidate emails that failed DMARC authentication',
      extra: { txn: txn.id, dropped: untrustedDropped },
    })
  }

  // Audit extras shared by every outcome that looked at emails.
  const lookExtra = {
    emails_found: messages.length,
    ...(capped && { emails_capped: true }),
    ...(untrustedDropped > 0 && { untrusted_dropped: untrustedDropped }),
  }

  if (messages.length === 0) {
    // Candidates existed but none survived the trust filter — nothing safe to send.
    return {
      kind: 'skip',
      auditCore: buildAuditEntry({
        txn,
        status: 'no_emails',
        extra: { ...lookExtra, new_memo: null },
      }),
    }
  }

  const prompt = buildEnrichPrompt({
    transactionDate: txn.date,
    amount,
    emails: messages.map(m => ({
      subject: m.subject,
      from: m.from,
      date: m.date,
      bodyText: m.bodyText,
    })),
  })

  const result = await llm.extractReceipt({ prompt })
  logger.debug({
    msg: 'Receipt extraction',
    extra: {
      txn: txn.id,
      emails: messages.length,
      found: result.summary !== null,
      latency_ms: result.latencyMs,
    },
  })

  if (!result.summary) {
    return {
      kind: 'skip',
      auditCore: buildAuditEntry({
        txn,
        status: 'no_receipt',
        extra: { ...lookExtra, new_memo: null },
      }),
    }
  }

  // Deterministic backstop to the prompt's amount rule: never write a memo we can't confirm
  // matches the charge. Fails closed — a missing total (can't verify) is rejected just like a
  // mismatched one. This is what silently mis-matched a receipt before: the real receipt was
  // truncated by the fetch cap and the model settled for a wrong-amount one.
  if (
    result.orderTotal === null ||
    Math.abs(result.orderTotal - amount) > ORDER_TOTAL_TOLERANCE_DOLLARS
  ) {
    logger.warn({
      msg: 'Matched receipt total is missing or does not match the charge; rejecting',
      extra: { txn: txn.id, charge_dollars: amount, order_total: result.orderTotal },
    })

    return {
      kind: 'skip',
      auditCore: buildAuditEntry({
        txn,
        status: 'no_receipt',
        extra: { ...lookExtra, new_memo: null },
      }),
    }
  }

  const memo = buildMemo(result.summary)

  return {
    kind: 'patch',
    patch: { id: txn.id, memo },
    auditCore: buildAuditEntry({
      txn,
      status: 'ok',
      extra: {
        ...lookExtra,
        new_memo: memo,
        latency_ms: result.latencyMs,
        ...(result.inputTokens !== undefined && { prompt_tokens: result.inputTokens }),
      },
    }),
  }
}

async function patchInBatches({
  outcomes,
  ynab,
  logger,
}: {
  outcomes: PatchOutcome[]
  ynab: YnabClient
  logger: Logger<EnrichMemosAudit>
}): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0
  let failed = 0

  for (const batch of chunks({ arr: outcomes, size: PATCH_BATCH_SIZE })) {
    const patches = batch.map(o => o.patch)
    logger.info({ msg: 'PATCH batch', extra: { size: batch.length } })

    let updatedIds: PatchTransactionsResult['updatedIds']
    try {
      ;({ updatedIds } = await ynab.patchTransactions(patches))
    } catch (err) {
      if (!(err instanceof YnabApiError)) throw err
      failed += batch.length
      logger.error({ msg: 'PATCH batch failed', extra: { size: batch.length, error: err.message } })
      for (const o of batch) {
        logger.audit({ ...o.auditCore, patch_status: 'error', error: err.message })
      }
      continue
    }

    const updated = new Set(updatedIds)
    let missing = 0
    for (const o of batch) {
      if (updated.has(o.patch.id)) {
        succeeded += 1
        logger.audit({ ...o.auditCore, patch_status: 'success' })
      } else {
        failed += 1
        missing += 1
        logger.audit({
          ...o.auditCore,
          patch_status: 'error',
          error: 'not in YNAB response transaction_ids',
        })
      }
    }
    if (missing > 0) {
      logger.warn({
        msg: 'PATCH batch had ids missing from response',
        extra: { size: batch.length, missing },
      })
    }
  }

  return { succeeded, failed }
}

export function isEligible({
  txn,
  allowedAccountIds,
}: {
  txn: Transaction
  allowedAccountIds: Set<string>
}): boolean {
  if (!allowedAccountIds.has(txn.account_id)) return false
  if (txn.payee_name !== PAYEE_FILTER) return false
  if (txn.transfer_account_id) return false
  if (txn.transfer_transaction_id) return false
  // Only enrich empty memos. Any non-empty memo is left untouched — whether it's a note you
  // typed or this job's own `auto-gen:` output (which also means we never overwrite the memo
  // the categorizer read, since the categorizer runs after us). To regenerate, clear the memo.
  if (txn.memo?.trim()) return false

  return true
}

export function buildRunAbortedAuditEntry(err: unknown): EnrichMemosAudit {
  return {
    app: 'ynab-enrich-memos',
    timestamp: new Date().toISOString(),
    transaction_id: RUN_ABORTED_SENTINEL,
    payee_name: null,
    memo: null,
    amount_dollars: 0,
    patch_status: 'error',
    status: 'error',
    new_memo: null,
    error: formatError(err),
  }
}

export function buildAuditEntry({
  txn,
  status,
  extra,
}: {
  txn: Transaction
  status: EnrichMemosAudit['status']
  extra?: Partial<AuditCore>
}): AuditCore {
  return {
    app: 'ynab-enrich-memos',
    timestamp: new Date().toISOString(),
    transaction_id: txn.id,
    payee_name: txn.payee_name,
    memo: txn.memo,
    amount_dollars: milliunitsToDollars(txn.amount),
    status,
    ...extra,
  }
}
