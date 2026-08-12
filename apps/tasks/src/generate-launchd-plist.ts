import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonValue, loadAppEnv, resolveWorkspaceRoot } from '@personal-automation/common/env'
import { formatError } from '@personal-automation/common/errors'
import { z } from 'zod'
import { buildTasksDigestPlist, parseSchedule } from './schedule.js'

// Reads TASKS_SCHEDULE from the tasks .env and writes the dedicated launchd agent
// plist. Invoked by launchd/setup.sh; re-run whenever the schedule changes. The plist is gitignored
// (machine-specific paths), like the YNAB one.
loadAppEnv(import.meta.url)

function main(): void {
  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const entries = jsonValue.pipe(z.array(z.string())).parse(process.env['TASKS_SCHEDULE'])
  const schedule = parseSchedule(entries)
  const projectDir = resolveWorkspaceRoot(import.meta.url)
  const outPath = join(projectDir, 'launchd', 'com.personal-automation.tasks.plist')

  writeFileSync(outPath, buildTasksDigestPlist({ projectDir, schedule }))

  console.log(`Generated ${outPath}`)
  for (const slot of schedule) {
    const time = `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`
    console.log(`  • ${slot.day} ${time}`)
  }
}

try {
  main()
} catch (err) {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
}
