import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fatal, runWithLock } from '@personal-automation/common/cli'
import { AppError } from '@personal-automation/common/errors'
import { parseArgs } from './cli-args.js'
import { type MigrateResult, runMigrate } from './commands/migrate.js'
import { renderMigrationReport } from './commands/migrate-report.js'
import { loadConfig } from './config.js'
import { type RunResult, runDigest } from './run.js'
import { DEFAULT_TODOS_FILE } from './tasks/obsidian/source.js'

// One lock for every subcommand: the digest and the migration both read the same vault, and a
// migration writing while a digest reads would show the digest a half-tagged vault.
const LOCK_PATH = join(tmpdir(), 'tasks.lock')

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
    lockPath: LOCK_PATH,
    run: async () => {
      const config = loadConfig()
      if (args.command === 'digest') {
        logDigestResult(await runDigest({ config, opts: { dryRun: args.dryRun } }))

        return
      }

      const vaultPath = config.obsidianVaultPath
      if (!vaultPath) {
        throw new AppError({
          message: 'migrate needs OBSIDIAN_VAULT_PATH to point at your vault.',
        })
      }
      // TASK_LISTS by default, so the migration and the digest always agree on what a task is.
      // An empty TASK_LISTS means the vault-root todos.md, matching the Obsidian source.
      const configured = config.taskLists.length > 0 ? config.taskLists : [DEFAULT_TODOS_FILE]
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
