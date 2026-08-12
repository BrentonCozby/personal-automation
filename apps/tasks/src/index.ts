import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fatal, runWithLock } from '@personal-automation/common/cli'
import { loadConfig } from './config.js'
import { type RunResult, runDigest } from './run.js'

const LOCK_PATH = join(tmpdir(), 'tasks.lock')

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
      throw new Error(`Unhandled run result: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Lock prevents overlapping manual + scheduled runs; a stale lock from a crashed run is claimed.
  await runWithLock({
    lockPath: LOCK_PATH,
    run: async () => {
      const config = loadConfig()
      const result = await runDigest({ config, opts: args })
      logResult(result)
    },
  })
}

main().catch(fatal)
