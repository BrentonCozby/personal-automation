import { chunks } from '@ynab-automation/common/chunks'
import { isoDateNDaysAgo } from '@ynab-automation/common/date'
import { type AuditEntry, createLogger, type Logger } from '@ynab-automation/common/logger'
import { createProgress } from '@ynab-automation/common/progress'
import { createYnabClient, type YnabClient } from '@ynab-automation/ynab/client'
import { formatDollars, milliunitsToDollars } from '@ynab-automation/ynab/milliunits'
import type {
  Category,
  CategoryGroup,
  Transaction,
  TransactionPatch,
} from '@ynab-automation/ynab/types'
import pLimit from 'p-limit'
import {
  type AnthropicCategorizeClient,
  type CategorizationResult,
  createAnthropicClient,
} from './anthropic/client.js'
import { buildCategorizationPrompt, type PromptCategory } from './anthropic/prompts.js'
import type { Config } from './config.js'
import { FLAG_COLOR, FLAG_NAME, PATCH_BATCH_SIZE, PAYEE_FILTER } from './constants.js'

const INTERNAL_MASTER_GROUP = 'Internal Master Category'
const UNCATEGORIZED_NAME = 'Uncategorized'
// Anthropic accepts concurrent requests; modest parallelism is plenty for the daily volume
// and keeps rate-limit pressure low.
const CATEGORIZE_CONCURRENCY = 4
const PROGRESS_LOG_EVERY = 10

export type RunOptions = {
  dryRun: boolean
  verbose: boolean
  lookbackDays?: number
}

export type RunResult = {
  succeeded: number
  failed: number
  skipped: number
}

type CategoriesContext = {
  promptCategories: PromptCategory[]
  uncategorizedId: string
  validCategoryIds: Set<string>
  categoryNamesById: Map<string, string>
  routingHints: readonly string[]
}

type CategorizationOutcome = { patch: TransactionPatch; auditEntry: AuditEntry }

export async function runCategorize({
  config,
  opts,
}: {
  config: Config
  opts: RunOptions
}): Promise<RunResult> {
  const logger = createLogger({
    verbose: opts.verbose,
    name: 'categorize',
    auditDir: config.auditDir,
  })
  const ynab = createYnabClient({ token: config.ynabToken, budgetId: config.budgetId })
  const llm = createAnthropicClient({
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
  })

  // Spinners only show when stdout is a TTY. In non-TTY runs (launchd), periodic pino
  // progress logs take over so a long run isn't silent.
  const spinnersEnabled = process.stdout.isTTY === true

  const lookback = opts.lookbackDays || config.lookbackDays
  const sinceDate = isoDateNDaysAgo(lookback)

  logger.info({
    msg: 'Starting categorize run',
    extra: {
      budget_id: config.budgetId,
      since_date: sinceDate,
      lookback_days: lookback,
      dry_run: opts.dryRun,
    },
  })

  const loadProgress = createProgress({
    enabled: spinnersEnabled,
    text: 'Loading categories and transactions…',
  })
  const [groups, transactions] = await Promise.all([
    ynab.getCategoryGroups(),
    ynab.getTransactionsForAccounts({
      accountIds: config.allowedAccountIds,
      sinceDate,
    }),
  ])
  loadProgress.succeed(
    `Loaded ${groups.length} category groups and ${transactions.length} transactions`,
  )

  const allCategories = flattenCategories(groups)
  const uncategorizedId = findUncategorizedId(allCategories)
  if (!uncategorizedId) {
    throw new Error(`Could not find "${UNCATEGORIZED_NAME}" category — needed for LLM fallback.`)
  }

  const promptCategories = filterCategoriesForPrompt({
    categories: allCategories,
    excludedGroups: config.excludedCategoryGroups,
  })
  const validCategoryIds = new Set(promptCategories.map(c => c.id))
  validCategoryIds.add(uncategorizedId)
  const categoryNamesById = new Map(allCategories.map(c => [c.id, c.name]))
  const categories: CategoriesContext = {
    promptCategories,
    uncategorizedId,
    validCategoryIds,
    categoryNamesById,
    routingHints: config.categoryRoutingHints,
  }

  logger.info({ msg: 'Categories available to LLM', extra: { count: promptCategories.length } })

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

  const categorizeProgress = createProgress({
    enabled: spinnersEnabled,
    text: `Categorizing 0/${eligible.length}…`,
  })
  let done = 0
  let lastLogged = 0

  const outcomes = await categorizeAll({
    eligible,
    categories,
    llm,
    logger,
    onProgress: () => {
      done++
      categorizeProgress.update(`Categorizing ${done}/${eligible.length}…`)
      if (
        !spinnersEnabled &&
        (done - lastLogged >= PROGRESS_LOG_EVERY || done === eligible.length)
      ) {
        logger.info({
          msg: 'Categorize progress',
          extra: { done, total: eligible.length },
        })
        lastLogged = done
      }
    },
  })
  categorizeProgress.succeed(
    `Categorized ${eligible.length} transactions` +
      (outcomes.categorizeFailed > 0 ? ` (${outcomes.categorizeFailed} failed)` : ''),
  )

  if (opts.dryRun) {
    // Emit audit immediately in dry-run since no PATCH will happen.
    for (const o of outcomes.successes) logger.audit(o.auditEntry)
    logger.info({ msg: 'Dry run — skipping PATCH', extra: { proposed: outcomes.successes.length } })

    return {
      succeeded: outcomes.successes.length,
      failed: outcomes.categorizeFailed,
      skipped: outcomes.successes.length,
    }
  }

  const patchResult = await patchInBatches({
    outcomes: outcomes.successes,
    ynab,
    logger,
  })

  logger.info({
    msg: 'Done',
    extra: {
      succeeded: patchResult.succeeded,
      categorize_failed: outcomes.categorizeFailed,
      patch_failed: patchResult.failed,
    },
  })

  return {
    succeeded: patchResult.succeeded,
    failed: outcomes.categorizeFailed + patchResult.failed,
    skipped: 0,
  }
}

async function categorizeAll({
  eligible,
  categories,
  llm,
  logger,
  onProgress,
}: {
  eligible: Transaction[]
  categories: CategoriesContext
  llm: AnthropicCategorizeClient
  logger: Logger
  onProgress?: () => void
}): Promise<{ successes: CategorizationOutcome[]; categorizeFailed: number }> {
  const limit = pLimit(CATEGORIZE_CONCURRENCY)
  const settled = await Promise.allSettled(
    eligible.map(txn =>
      limit(async () => {
        try {
          return await categorizeOne({ txn, categories, llm, logger })
        } finally {
          onProgress?.()
        }
      }),
    ),
  )

  const successes: CategorizationOutcome[] = []
  let categorizeFailed = 0
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const txn = eligible[i]
    if (!result || !txn) continue
    if (result.status === 'fulfilled') {
      successes.push(result.value)
    } else {
      categorizeFailed += 1
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
      logger.error({
        msg: `Categorize failed for ${txn.id}`,
        extra: { error: message },
      })
      logger.audit(
        buildAuditEntry({
          txn,
          categoryId: null,
          categoryName: null,
          extra: { status: 'error', error: message },
        }),
      )
    }
  }

  return { successes, categorizeFailed }
}

async function patchInBatches({
  outcomes,
  ynab,
  logger,
}: {
  outcomes: CategorizationOutcome[]
  ynab: YnabClient
  logger: Logger
}): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0
  let failed = 0

  for (const batch of chunks({ arr: outcomes, size: PATCH_BATCH_SIZE })) {
    const patches = batch.map(o => o.patch)
    logger.info({ msg: 'PATCH batch', extra: { size: batch.length } })
    try {
      await ynab.patchTransactions(patches)
      succeeded += batch.length
      for (const o of batch) logger.audit(o.auditEntry)
    } catch (err) {
      failed += batch.length
      const message = err instanceof Error ? err.message : String(err)
      logger.error({
        msg: 'PATCH batch failed',
        extra: { size: batch.length, error: message },
      })
      for (const o of batch) {
        logger.audit({ ...o.auditEntry, status: 'patch_error', error: message })
      }
    }
  }

  return { succeeded, failed }
}

async function categorizeOne({
  txn,
  categories,
  llm,
  logger,
}: {
  txn: Transaction
  categories: CategoriesContext
  llm: AnthropicCategorizeClient
  logger: Logger
}): Promise<CategorizationOutcome> {
  const { promptCategories, uncategorizedId, validCategoryIds, categoryNamesById, routingHints } =
    categories

  const prompt = buildCategorizationPrompt({
    transactionId: txn.id,
    memo: txn.memo,
    categories: promptCategories,
    uncategorizedId,
    routingHints,
  })

  const result = await llm.categorize({ prompt })
  const { id: chosenId, status } = resolveCategoryId({
    result,
    txnId: txn.id,
    validCategoryIds,
    uncategorizedId,
    logger,
  })

  const chosenName = categoryNamesById.get(chosenId) || UNCATEGORIZED_NAME
  logger.debug({
    msg: 'Chose category',
    extra: {
      txn: txn.id,
      memo: txn.memo,
      category_id: chosenId,
      category_name: chosenName,
      latency_ms: result.latencyMs,
    },
  })

  const auditEntry = buildAuditEntry({
    txn,
    categoryId: chosenId,
    categoryName: chosenName,
    extra: {
      status,
      latency_ms: result.latencyMs,
      ...(result.inputTokens !== undefined && { prompt_tokens: result.inputTokens }),
    },
  })

  return {
    patch: {
      id: txn.id,
      category_id: chosenId,
      flag_color: FLAG_COLOR,
      flag_name: FLAG_NAME,
    },
    auditEntry,
  }
}

export function flattenCategories(groups: CategoryGroup[]): Category[] {
  const out: Category[] = []
  for (const group of groups) {
    if (group.hidden || group.deleted) continue
    for (const cat of group.categories) {
      if (cat.hidden || cat.deleted) continue
      out.push({ ...cat, category_group_name: cat.category_group_name || group.name })
    }
  }

  return out
}

export function findUncategorizedId(categories: Category[]): string | undefined {
  return categories.find(
    c => c.category_group_name === INTERNAL_MASTER_GROUP && c.name === UNCATEGORIZED_NAME,
  )?.id
}

export function filterCategoriesForPrompt({
  categories,
  excludedGroups,
}: {
  categories: Category[]
  excludedGroups: Set<string>
}): PromptCategory[] {
  return categories
    .filter(c => c.category_group_name !== INTERNAL_MASTER_GROUP)
    .filter(c => !excludedGroups.has(c.category_group_name))
    .map(c => ({ id: c.id, name: c.name }))
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
  if (txn.flag_name === FLAG_NAME) return false

  return true
}

function resolveCategoryId({
  result,
  txnId,
  validCategoryIds,
  uncategorizedId,
  logger,
}: {
  result: CategorizationResult
  txnId: string
  validCategoryIds: Set<string>
  uncategorizedId: string
  logger: Logger
}): { id: string; status: AuditEntry['status'] } {
  const fallback = { id: uncategorizedId, status: 'fallback' } as const

  if (!result.categoryId) {
    logger.warn({
      msg: `LLM returned no category_id for ${txnId} — falling back to Uncategorized`,
    })

    return fallback
  }

  if (!validCategoryIds.has(result.categoryId)) {
    logger.warn({
      msg: `LLM chose unknown category ${result.categoryId} for ${txnId} — falling back to Uncategorized`,
    })

    return fallback
  }

  return { id: result.categoryId, status: 'ok' }
}

export function buildAuditEntry({
  txn,
  categoryId,
  categoryName,
  extra,
}: {
  txn: Transaction
  categoryId: string | null
  categoryName: string | null
  extra: Partial<AuditEntry>
}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    transaction_id: txn.id,
    payee_name: txn.payee_name,
    memo: txn.memo,
    amount_dollars: milliunitsToDollars(txn.amount),
    chosen_category_id: categoryId,
    chosen_category_name: categoryName,
    status: 'ok',
    ...extra,
  }
}

export { formatDollars }
