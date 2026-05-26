import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatError } from '@ynab-automation/common/errors'
import { acquireLock, type LockHandle, LockHeldError } from '@ynab-automation/common/lock'
import { runCategorize } from './categorize.js'
import { loadConfig } from './config.js'

const LOCK_PATH = join(tmpdir(), 'ynab-categorize.lock')

type Args = { dryRun: boolean; verbose: boolean; lookbackDays?: number }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--verbose' || a === '-v') args.verbose = true
    else if (a === '--lookback-days') {
      const next = argv[++i]
      if (!next) throw new Error('--lookback-days requires a number')
      const n = Number(next)
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`--lookback-days must be a positive integer (got ${next})`)
      args.lookbackDays = n
    } else if (a === '--help' || a === '-h') {
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
  --dry-run             Run the workflow but do not PATCH transactions
  --verbose, -v         Verbose stdout logging (audit log is always written)
  --lookback-days N     Override LOOKBACK_DAYS env var
  --help, -h            Show this help`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Prevent overlapping launchd / manual runs. Stale locks from crashed runs are claimed.
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

  // Best-effort cleanup on signals so we don't leave a stale lock on Ctrl-C or launchd kill.
  const cleanupAndExit = (signalExitCode: number): void => {
    lock.release()
    process.exit(signalExitCode)
  }
  process.on('SIGINT', () => cleanupAndExit(130))
  process.on('SIGTERM', () => cleanupAndExit(143))

  try {
    const config = loadConfig()
    const result = await runCategorize({ config, opts: args })
    console.log(
      `Summary: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`,
    )
    if (result.failed > 0) process.exit(1)
  } finally {
    lock.release()
  }
}

main().catch(err => {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
})
