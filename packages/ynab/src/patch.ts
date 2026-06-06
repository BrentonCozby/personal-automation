import { chunks } from '@personal-automation/common/chunks'
import { YnabApiError } from '@personal-automation/common/errors'
import type { BaseAudit, Logger, PatchStatus } from '@personal-automation/common/logger'
import type { YnabClient } from './client.js'
import type { TransactionPatch } from './types.js'

/**
 * A patch to apply plus the audit row to emit for it, minus `patch_status` — patchInBatches sets
 * the status from the PATCH outcome. `TCore` is the app's own audit shape with `patch_status`
 * omitted (e.g. `Omit<CategorizeAudit, 'patch_status'>`).
 */
export type PatchOutcome<TCore> = { patch: TransactionPatch; auditCore: TCore }

/**
 * PATCHes outcomes in batches and writes one audit row per transaction reflecting what happened:
 * `success` for ids YNAB confirms, `error` for a failed batch or for ids missing from the
 * response. Shared by the YNAB apps so the batching + per-row audit logic lives once.
 */
export async function patchInBatches<TAudit extends BaseAudit>({
  outcomes,
  ynab,
  logger,
  batchSize,
}: {
  outcomes: PatchOutcome<Omit<TAudit, 'patch_status'>>[]
  ynab: YnabClient
  logger: Logger<TAudit>
  batchSize: number
}): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0
  let failed = 0

  for (const batch of chunks({ arr: outcomes, size: batchSize })) {
    const patches = batch.map(o => o.patch)
    logger.info({ msg: 'PATCH batch', extra: { size: batch.length } })

    let updatedIds: string[]
    try {
      ;({ updatedIds } = await ynab.patchTransactions(patches))
    } catch (err) {
      if (!(err instanceof YnabApiError)) throw err
      failed += batch.length
      logger.error({ msg: 'PATCH batch failed', extra: { size: batch.length, error: err.message } })
      for (const o of batch) {
        logger.audit(withStatus(o.auditCore, { patch_status: 'error', error: err.message }))
      }
      continue
    }

    const updated = new Set(updatedIds)
    let missing = 0
    for (const o of batch) {
      if (updated.has(o.patch.id)) {
        succeeded += 1
        logger.audit(withStatus(o.auditCore, { patch_status: 'success' }))
      } else {
        failed += 1
        missing += 1
        logger.audit(
          withStatus(o.auditCore, {
            patch_status: 'error',
            error: 'not in YNAB response transaction_ids',
          }),
        )
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

// Rebuild the full audit row from the patch_status-less core plus the resolved status. The
// constraint guarantees `Omit<TAudit, 'patch_status'> & { patch_status }` is exactly `TAudit`,
// but TS can't prove that for a generic T, so assert. (Standard generic-Omit limitation.)
function withStatus<TAudit extends BaseAudit>(
  core: Omit<TAudit, 'patch_status'>,
  fields: { patch_status: PatchStatus; error?: string },
): TAudit {
  return { ...core, ...fields } as TAudit
}
