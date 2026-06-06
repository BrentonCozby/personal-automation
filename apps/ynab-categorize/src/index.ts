import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fatal, runWithLock } from '@personal-automation/common/cli'
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

  // Lock prevents overlapping launchd / manual runs; stale locks from crashed runs are claimed.
  await runWithLock({
    lockPath: LOCK_PATH,
    run: async () => {
      const config = loadConfig()
      const result = await runCategorize({ config, opts: args })
      console.log(
        `Summary: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`,
      )
      if (result.failed > 0) process.exit(1)
    },
  })
}

main().catch(fatal)
