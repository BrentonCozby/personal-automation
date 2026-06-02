import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatError } from '@personal-automation/common/errors'
import { acquireLock, type LockHandle, LockHeldError } from '@personal-automation/common/lock'
import { loadConfig } from './config.js'
import { type RunResult, runStalledTasks } from './run.js'

const LOCK_PATH = join(tmpdir(), 'stalled-tasks.lock')

type Args = { dryRun: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false }
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }

  return args
}

function printHelp(): void {
  console.log(`Usage: tsx src/index.ts [options]

Options:
  --dry-run    Print the digest to the console instead of sending email
  --help, -h   Show this help`)
}

function logResult(result: RunResult): void {
  switch (result.kind) {
    case 'no_open_tasks':
      console.log('No open reminders found. Nothing to do.')
      break
    case 'no_actionable':
      console.log(
        `${result.totalStalled} stalled, none actionable enough to flag this week. No email.`,
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
      throw new Error(`Unhandled run result: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Prevent overlapping manual + scheduled runs. A stale lock from a crashed run is claimed.
  let lock: LockHandle
  try {
    lock = acquireLock(LOCK_PATH)
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`[FATAL] ${err.message}. Another run is in progress; exiting.`)
      process.exit(2)
    }
    throw err
  }

  // Best-effort cleanup on signals so a Ctrl-C or launchd kill doesn't leave a stale lock.
  const cleanupAndExit = (signalExitCode: number): void => {
    lock.release()
    process.exit(signalExitCode)
  }
  process.on('SIGINT', () => cleanupAndExit(130))
  process.on('SIGTERM', () => cleanupAndExit(143))

  try {
    const config = loadConfig()
    const result = await runStalledTasks({ config, opts: args })
    logResult(result)
  } finally {
    lock.release()
  }
}

main().catch(err => {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
})
