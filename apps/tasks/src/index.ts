import { fatal, runWithLock } from '@personal-automation/common/cli'
import { AppError } from '@personal-automation/common/errors'
import { parseArgs } from './cli-args.js'
import { runAbandon } from './commands/abandon.js'
import { type MigrateResult, runMigrate } from './commands/migrate.js'
import { renderMigrationReport } from './commands/migrate-report.js'
import { runPromote } from './commands/promote.js'
import {
  renderAbandonResult,
  renderPromoteResult,
  renderScheduleResult,
} from './commands/reports.js'
import { runSchedule } from './commands/schedule.js'
import { loadConfig } from './config.js'
import { lockPathFor } from './locks.js'
import { type RunResult, runDigest } from './run.js'
import { DEFAULT_TODOS_FILE } from './tasks/obsidian/vault.js'

function printHelp(): void {
  console.log(`Usage: tsx src/index.ts <command> [options]

Commands:
  digest              Review #active tasks and email the digest
    --dry-run         Print it to the console instead of sending

  migrate             Give every task a state tag. Dry by default.
                      Reads the same files as the digest (TASK_LISTS).
    --apply           Write the changes (needs a clean git state per file)
    --scope <path>    Read this folder or file instead, relative to the
                      vault root. Most checkboxes elsewhere in a vault are
                      steps inside notes rather than tasks.

  promote <title>     Tag one open task #active, up to the cap of
                      TASKS_WIP_CAP. Any part of the title will do; no
                      quoting needed.
    --over-cap        Allow one more than the cap for this promotion

  schedule <title> <date>
                      Put a date on one task: YYYY-MM-DD or +Nd. A date
                      past the TASKS_HORIZON_DAYS horizon moves it to
                      #someday instead of pretending it is planned.

  abandon <title>     Drop one task: cancels its checkbox and dates it.
                      This is the supported way to make room.

  --help, -h          Show this help`)
}

function logDigestResult(result: RunResult): void {
  switch (result.kind) {
    case 'no_open_tasks':
      console.log('No open tasks found. Nothing to do.')
      break
    case 'no_actionable':
      console.log(
        `${result.totalStalled} stalled, none actionable enough to flag right now. No email.`,
      )
      break
    case 'dry_run':
      console.log(`\n${result.subject}\n\n${result.body}\n`)
      console.log(
        `[dry run] ${result.flaggedCount} flagged of ${result.totalStalled} stalled — not sent.`,
      )
      break
    case 'sent':
      console.log(`Sent digest — ${result.flaggedCount} flagged (message_id=${result.messageId}).`)
      break
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled run result: ${JSON.stringify(_exhaustive)}` })
    }
  }
}

function logMigrateResult({
  result,
  vaultPath,
}: {
  result: MigrateResult
  vaultPath: string
}): void {
  switch (result.kind) {
    case 'dry_run':
      console.log(renderMigrationReport({ plan: result.plan, isApplied: false }))
      break
    case 'blocked':
      console.log(renderBlocked({ result, vaultPath }))
      process.exitCode = 1
      break
    case 'applied':
      console.log(renderMigrationReport({ plan: result.plan, isApplied: true }))
      if (result.conflicted.length > 0) {
        console.log(
          `\nLeft untouched, because they changed while the pass was reading them:\n${result.conflicted
            .map(path => `  ${path}`)
            .join('\n')}\nRun migrate again to pick them up.`,
        )
      }
      break
    default: {
      const _exhaustive: never = result
      throw new AppError({ message: `Unhandled migrate result: ${JSON.stringify(_exhaustive)}` })
    }
  }
}

function renderBlocked({
  result,
  vaultPath,
}: {
  result: Extract<MigrateResult, { kind: 'blocked' }>
  vaultPath: string
}): string {
  if (result.check.kind === 'not_a_repo') {
    return [
      `The vault at ${vaultPath} is not a git repository, so this pass could not be undone in one`,
      'command. Nothing was written. Put the vault under git first, then run it again.',
    ].join('\n')
  }
  if (result.check.kind === 'ok') return ''

  const lines = ['Nothing was written. These files could not be restored from git afterwards:', '']
  if (result.check.untracked.length > 0) {
    lines.push('Not tracked by git:', ...result.check.untracked.map(path => `  ${path}`), '')
  }
  if (result.check.modified.length > 0) {
    lines.push(
      'Tracked, with uncommitted edits:',
      ...result.check.modified.map(path => `  ${path}`),
      '',
    )
  }
  lines.push('Commit or stash them in the vault, then run this again.')

  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'help') {
    printHelp()

    return
  }

  // Lock prevents overlapping manual + scheduled runs; a stale lock from a crashed run is claimed.
  await runWithLock({
    lockPath: lockPathFor(args.command),
    run: async () => {
      const config = loadConfig()
      if (args.command === 'digest') {
        logDigestResult(await runDigest({ config, opts: { dryRun: args.dryRun } }))

        return
      }

      const vaultPath = config.obsidianVaultPath
      if (!vaultPath) {
        throw new AppError({
          message: `${args.command} needs OBSIDIAN_VAULT_PATH to point at your vault.`,
        })
      }
      // TASK_LISTS by default, so every command agrees on what a task is. An empty TASK_LISTS
      // means the vault-root todos.md, matching the Obsidian source.
      const configured = config.taskLists.length > 0 ? config.taskLists : [DEFAULT_TODOS_FILE]

      if (args.command === 'promote') {
        const promoted = await runPromote({
          vaultPath,
          scopes: configured,
          query: args.query,
          cap: config.wipCap,
          isOverCap: args.isOverCap,
        })
        console.log(renderPromoteResult({ result: promoted, now: new Date() }))
        // Anything but a promotion or a task that was already active left the request unfulfilled.
        if (promoted.kind !== 'promoted' && promoted.kind !== 'already_active') {
          process.exitCode = 1
        }

        return
      }

      if (args.command === 'schedule') {
        const scheduled = await runSchedule({
          vaultPath,
          scopes: configured,
          query: args.query,
          dateInput: args.date,
          horizonDays: config.horizonDays,
        })
        console.log(renderScheduleResult(scheduled))
        if (scheduled.kind !== 'scheduled') process.exitCode = 1

        return
      }

      if (args.command === 'abandon') {
        const abandoned = await runAbandon({ vaultPath, scopes: configured, query: args.query })
        console.log(renderAbandonResult(abandoned))
        if (abandoned.kind !== 'abandoned') process.exitCode = 1

        return
      }

      const result = await runMigrate({
        vaultPath,
        isApply: args.isApply,
        scopes: args.scope !== undefined ? [args.scope] : configured,
      })
      logMigrateResult({ result, vaultPath })
    },
  })
}

main().catch(fatal)
