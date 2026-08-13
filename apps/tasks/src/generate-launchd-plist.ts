import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonValue, loadAppEnv, resolveWorkspaceRoot } from '@personal-automation/common/env'
import { formatError } from '@personal-automation/common/errors'
import { z } from 'zod'
import {
  buildTasksAlertPlist,
  buildTasksDigestPlist,
  parseAlertTimes,
  parseSchedule,
} from './schedule.js'

// Reads TASKS_SCHEDULE and TASKS_ALERT_TIMES from the tasks .env and writes both agents' plists
// (the digest and the due-date alert). Invoked by launchd/setup.sh; re-run whenever either
// changes. The plists are gitignored (machine-specific paths), like the YNAB one.
loadAppEnv(import.meta.url)

function main(): void {
  const projectDir = resolveWorkspaceRoot(import.meta.url)
  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const scheduleEntries = jsonValue.pipe(z.array(z.string())).parse(process.env['TASKS_SCHEDULE'])
  const schedule = parseSchedule(scheduleEntries)
  const digestPath = join(projectDir, 'launchd', 'com.personal-automation.tasks.plist')
  writeFileSync(digestPath, buildTasksDigestPlist({ projectDir, schedule }))
  console.log(`Generated ${digestPath}`)
  for (const slot of schedule) {
    console.log(`  • ${slot.day} ${hhmm(slot)}`)
  }

  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const timeEntries = jsonValue.pipe(z.array(z.string())).parse(process.env['TASKS_ALERT_TIMES'])
  const times = parseAlertTimes(timeEntries)
  const alertPath = join(projectDir, 'launchd', 'com.personal-automation.tasks-alert.plist')
  writeFileSync(alertPath, buildTasksAlertPlist({ projectDir, times }))
  console.log(`Generated ${alertPath}`)
  for (const slot of times) {
    console.log(`  • every day ${hhmm(slot)}`)
  }
}

function hhmm({ hour, minute }: { hour: number; minute: number }): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

try {
  main()
} catch (err) {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
}
