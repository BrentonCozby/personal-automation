import pino from 'pino'
import {
  type AlertMessage,
  buildAlertMessage,
  type DemotedItem,
  type DueItem,
} from '../alert-message.js'
import type { Config } from '../config.js'
import { ALERT_URL_TITLE } from '../constants.js'
import { createPushoverClient, type PushoverClient } from '../pushover/client.js'
import { decayed } from '../state/decay.js'
import { dueForAlert } from '../state/due.js'
import { untouchedDays } from '../state/stall.js'
import { defaultTouchClockPath, type TouchClock } from '../state/touch-clock.js'
import type { ScannedTask } from '../tasks/obsidian/scan.js'
import { withStateTag } from '../tasks/obsidian/tags.js'
import {
  fingerprintFor,
  notEditable,
  type ScannedCandidate,
  toCandidate,
  withTaskClock,
  writeTaskLine,
} from './task-io.js'

export type AlertOptions = {
  dryRun: boolean
}

export type AlertResult =
  | { kind: 'silent'; reason: 'nothing_due' }
  | {
      kind: 'dry_run'
      title: string
      message: string
      dueCount: number
      demotedCount: number
    }
  | {
      kind: 'sent'
      requestId: string
      dueCount: number
      demotedCount: number
    }

/** What one read of the vault produced. */
type Pass = {
  due: DueItem[]
  demoted: DemotedItem[]
}

/**
 * Pushes what is due to the phone, and demotes what has been sitting too long to still call
 * current.
 *
 * Two things the twice-weekly review cannot do. A recurring chore can never reach the review (the
 * cap and the stall rule both exclude it), so a missed dose has no other channel; and an `#active`
 * task nothing touches would otherwise hold its cap slot forever.
 *
 * Silence needs both halves empty. Nothing due and nothing demoted sends nothing, which is what the
 * evening pass usually does.
 */
export async function runAlert({
  config,
  scopes,
  opts,
  now = new Date(),
  clockPath = defaultTouchClockPath(),
  pushover,
  logger = pino({ level: 'info' }),
}: {
  config: Config
  scopes: readonly string[]
  opts: AlertOptions
  now?: Date
  clockPath?: string
  pushover?: PushoverClient
  logger?: pino.Logger
}): Promise<AlertResult> {
  const pass = await withTaskClock<Pass>({
    vaultPath: config.obsidianVaultPath,
    scopes,
    clockPath,
    now,
    act: async ({ open, clock }) => {
      const demotion = await demote({ open, clock, config, now, logger })
      // Read from the same scan the demotion started from. Rewriting a state tag changes neither
      // the due date nor the title, so which half runs first cannot change what is alerted.
      const due = dueForAlert({ tasks: open, dueAlertDays: config.dueAlertDays, now })
      logger.info(
        { open: open.length, due: due.length, demoted: demotion.items.length },
        'Read the vault.',
      )

      return { result: { due, demoted: demotion.items }, clock: demotion.clock }
    },
  })

  if (pass.due.length === 0 && pass.demoted.length === 0) {
    logger.info({ due: 0, demoted: 0 }, 'Nothing due and nothing demoted; no push.')

    return { kind: 'silent', reason: 'nothing_due' }
  }

  // Sent after the clock is saved rather than inside the pass: a refused push must not throw away
  // the fingerprint update that keeps a demotion from reading as a touch on the next run.
  const rendered: AlertMessage = buildAlertMessage({ due: pass.due, demoted: pass.demoted })
  if (opts.dryRun) {
    return {
      kind: 'dry_run',
      title: rendered.title,
      message: rendered.message,
      dueCount: pass.due.length,
      demotedCount: pass.demoted.length,
    }
  }

  const client =
    pushover ??
    createPushoverClient({ token: config.pushoverToken, userKey: config.pushoverUserKey })
  const sent = await client.send({
    title: rendered.title,
    message: rendered.message,
    url: config.alertUrl,
    urlTitle: ALERT_URL_TITLE,
  })
  logger.info(
    { requestId: sent.requestId, due: pass.due.length, demoted: pass.demoted.length },
    'Alert sent.',
  )

  return {
    kind: 'sent',
    requestId: sent.requestId,
    dueCount: pass.due.length,
    demotedCount: pass.demoted.length,
  }
}

/**
 * Strips `#active` from every task past the horizon and writes `#someday` in its place, one line at
 * a time.
 *
 * A line that moved while the pass was reading it is skipped and picked up next time, rather than
 * failing the run: the push still has to go out.
 */
async function demote({
  open,
  clock,
  config,
  now,
  logger,
}: {
  open: ScannedTask[]
  clock: TouchClock
  config: Config
  now: Date
  logger: pino.Logger
}): Promise<{ clock: TouchClock; items: DemotedItem[] }> {
  const aged: ScannedCandidate[] = open.map(task => ({ ...toCandidate({ task, clock }), task }))
  const items: DemotedItem[] = []
  let updated = clock

  for (const entry of decayed({ tasks: aged, horizonDays: config.horizonDays, now })) {
    const { task } = entry
    // Nothing reaches this today: every refusal `notEditable` reports is already excluded by
    // `countsTowardCap`, including a line carrying two state tags, whose `state` is undefined. Kept
    // because that exclusion lives in another file, so a change there would arrive here.
    const blocked = notEditable(task)
    if (blocked) {
      logger.warn(
        { title: task.title, path: task.path, line: task.lineNumber },
        'Left where it is: the line carries more than one state tag.',
      )
      continue
    }
    // Unreachable: a task the clock has never seen never decays. Narrowed rather than defaulted, so
    // no invented day count can reach the push.
    const quietDays = untouchedDays({ task: entry, now })
    if (quietDays === undefined) continue

    const after = withStateTag({ line: task.lineText, state: 'someday' })
    if (!(await writeTaskLine({ vaultPath: config.obsidianVaultPath, task, after }))) {
      logger.warn(
        { title: task.title, path: task.path },
        'Left where it is: the line moved while the pass was reading it. The next pass picks it up.',
      )
      continue
    }

    items.push({ title: task.title, untouchedDays: quietDays })
    updated = fingerprintFor({ clock: updated, task, after })
  }

  return { clock: updated, items }
}
