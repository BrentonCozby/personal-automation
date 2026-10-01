import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fatal } from '@personal-automation/common/cli'
import { todayIso } from '@personal-automation/common/date'
import { createYnabClient } from '@personal-automation/ynab/client'
import { loadConfig } from './config.js'
import { exportSpending, fullMonthsBefore, toCsv } from './export.js'

type Args = { months: number; out: string }

function parseArgs(argv: string[]): Args {
  let months = 12
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--months') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n <= 0) throw new Error('--months must be a positive integer')
      months = n
    } else if (a === '--out') {
      out = argv[++i]
    } else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  if (!out) throw new Error('--out <file.csv> is required')

  return { months, out }
}

function printHelp(): void {
  console.log(`Usage: tsx src/index.ts --out <file.csv> [--months N]

Writes spending per YNAB category for each of the last N full months (default 12).
Totals only: no payees, no individual transactions.`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const client = createYnabClient({ token: config.ynabToken, budgetId: config.budgetId })
  const months = fullMonthsBefore({
    available: await client.listMonths(),
    today: todayIso(),
    count: args.months,
  })
  if (months.length < args.months) {
    console.warn(`The budget has only ${months.length} finished months; exporting all of them.`)
  }
  const rows = await exportSpending({ months, getMonthCategories: client.getMonthCategories })
  // pnpm --filter runs the script from the app folder; INIT_CWD is where the command was typed.
  const out = resolve(process.env['INIT_CWD'] || process.cwd(), args.out)
  writeFileSync(out, toCsv(rows))
  console.log(`Wrote ${rows.length} rows for ${months[0]} to ${months.at(-1)} to ${out}`)
}

main().catch(fatal)
