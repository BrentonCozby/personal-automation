import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonValue, loadAppEnv, resolveWorkspaceRoot } from '@personal-automation/common/env'
import { formatError } from '@personal-automation/common/errors'
import { z } from 'zod'
import {
  assertNoScheduleCollision,
  buildTasksAlertPlist,
  buildTasksDigestPlist,
  formatTimeOfDay,
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
  // biome-ignore lint/complexity/useLiteralKeys: TS strict mode requires bracket access on process.env
  const timeEntries = jsonValue.pipe(z.array(z.string())).parse(process.env['TASKS_ALERT_TIMES'])
  const times = parseAlertTimes(timeEntries)
  // Both are read before either plist is written, so a rejected pair leaves the agents on the
  // schedule they already had instead of one new plist beside one old one.
  assertNoScheduleCollision({ schedule, times })

  const digestPath = join(projectDir, 'launchd', 'com.personal-automation.tasks.plist')
  writeFileSync(digestPath, buildTasksDigestPlist({ projectDir, schedule }))
  console.log(`Generated ${digestPath}`)
  for (const slot of schedule) {
    console.log(`  • ${slot.day} ${formatTimeOfDay(slot)}`)
  }

  const alertPath = join(projectDir, 'launchd', 'com.personal-automation.tasks-alert.plist')
  writeFileSync(alertPath, buildTasksAlertPlist({ projectDir, times }))
  console.log(`Generated ${alertPath}`)
  for (const slot of times) {
    console.log(`  • every day ${formatTimeOfDay(slot)}`)
  }
}

try {
  main()
} catch (err) {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
}
