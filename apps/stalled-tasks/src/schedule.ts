import { AppError } from '@personal-automation/common/errors'

/** Weekday names, index = launchd's StartCalendarInterval Weekday number (0 = Sunday). */
export const weekdayValues = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const
export type Weekday = (typeof weekdayValues)[number]

export type ScheduleSlot = {
  /** Full weekday name, for display. */
  day: Weekday
  /** launchd Weekday number (0 = Sunday … 6 = Saturday). */
  weekday: number
  hour: number
  minute: number
}

/**
 * Parses `STALLED_TASKS_SCHEDULE` entries like "Sunday 08:00" (day case-insensitive, 24h HH:MM)
 * into launchd calendar slots. Throws a clear AppError on a malformed entry so a typo fails at
 * setup time rather than silently producing the wrong schedule.
 */
export function parseSchedule(entries: readonly string[]): ScheduleSlot[] {
  if (entries.length === 0) {
    throw new AppError({
      message: 'STALLED_TASKS_SCHEDULE is empty — add at least one "Day HH:MM" entry.',
    })
  }

  return entries.map(parseSlot)
}

function parseSlot(entry: string): ScheduleSlot {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(entry)
  if (!match) {
    throw new AppError({
      message: `Invalid schedule entry "${entry}". Expected "<Day> HH:MM", e.g. "Sunday 08:00".`,
    })
  }
  const [, dayRaw = '', hourRaw = '', minuteRaw = ''] = match

  const day = weekdayValues.find(d => d.toLowerCase() === dayRaw.toLowerCase())
  if (!day) {
    throw new AppError({
      message: `Invalid day "${dayRaw}" in "${entry}". Use a full weekday name (e.g. Sunday).`,
    })
  }
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (hour > 23 || minute > 59) {
    throw new AppError({ message: `Invalid time in "${entry}". Use 24-hour HH:MM (00:00–23:59).` })
  }

  return { day, weekday: weekdayValues.indexOf(day), hour, minute }
}

const PLIST_DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'

/**
 * Builds the dedicated launchd agent plist for the digest. Its StartCalendarInterval is an
 * array of {Weekday, Hour, Minute} triggers — one per schedule slot — so the digest fires on
 * exactly the days and times configured, independent of the daily YNAB run.
 */
export function buildStalledTasksPlist({
  projectDir,
  schedule,
}: {
  projectDir: string
  schedule: ScheduleSlot[]
}): string {
  const intervals = schedule
    .map(
      slot => `    <dict>
      <key>Weekday</key><integer>${slot.weekday}</integer>
      <key>Hour</key><integer>${slot.hour}</integer>
      <key>Minute</key><integer>${slot.minute}</integer>
    </dict>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
${PLIST_DOCTYPE}
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.personal-automation.stalled-tasks</string>

    <key>ProgramArguments</key>
    <array>
        <string>${projectDir}/launchd/run-stalled-tasks.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>

    <key>StandardOutPath</key>
    <string>${projectDir}/launchd-stalled-tasks.out.log</string>
    <key>StandardErrorPath</key>
    <string>${projectDir}/launchd-stalled-tasks.err.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`
}
