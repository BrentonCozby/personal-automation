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
 * Parses `TASKS_SCHEDULE` entries like "Sunday 08:00" (day case-insensitive, 24h HH:MM)
 * into launchd calendar slots. Throws a clear AppError on a malformed entry so a typo fails at
 * setup time rather than silently producing the wrong schedule.
 */
export function parseSchedule(entries: readonly string[]): ScheduleSlot[] {
  if (entries.length === 0) {
    throw new AppError({
      message: 'TASKS_SCHEDULE is empty. Add at least one "Day HH:MM" entry.',
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

/** A time of day the alert fires, every day. */
export type TimeSlot = {
  hour: number
  minute: number
}

/**
 * Parses `TASKS_ALERT_TIMES` entries like "08:00" into launchd calendar slots. No day: the alert
 * runs every day, so an entry carries a time and nothing else.
 */
export function parseAlertTimes(entries: readonly string[]): TimeSlot[] {
  if (entries.length === 0) {
    throw new AppError({
      message: 'TASKS_ALERT_TIMES is empty. Add at least one "HH:MM" entry.',
    })
  }

  return entries.map(parseTime)
}

function parseTime(entry: string): TimeSlot {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(entry)
  if (!match) {
    throw new AppError({
      message: `Invalid alert time "${entry}". Expected 24-hour HH:MM, e.g. "08:00".`,
    })
  }
  const [, hourRaw = '', minuteRaw = ''] = match
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (hour > 23 || minute > 59) {
    throw new AppError({ message: `Invalid alert time "${entry}". Use 00:00 to 23:59.` })
  }

  return { hour, minute }
}

/** 24-hour HH:MM, zero-padded. */
export function formatTimeOfDay({ hour, minute }: { hour: number; minute: number }): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * Refuses a configuration where the alert fires in the same minute as the review.
 *
 * The two agents hold different locks, so nothing serializes them, and each one saves the whole
 * touch clock: at the same minute the later save wins and drops what the other recorded. No run can
 * detect that afterwards, so it is checked here, before the plists that would schedule it exist.
 */
export function assertNoScheduleCollision({
  schedule,
  times,
}: {
  schedule: readonly ScheduleSlot[]
  times: readonly TimeSlot[]
}): void {
  const collision = schedule.find(slot =>
    times.some(time => time.hour === slot.hour && time.minute === slot.minute),
  )
  if (!collision) return

  const time = formatTimeOfDay(collision)

  throw new AppError({
    message: `TASKS_ALERT_TIMES names ${time}, which TASKS_SCHEDULE already uses (${collision.day} ${time}). Move one of them by a minute: the review and the alert both save the touch clock, and the later save replaces the whole file.`,
  })
}

const PLIST_DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'

/**
 * Builds the dedicated launchd agent plist for the digest. Its StartCalendarInterval is an
 * array of {Weekday, Hour, Minute} triggers (one per schedule slot), so the digest fires on
 * exactly the days and times configured, independent of the daily YNAB run.
 */
export function buildTasksDigestPlist({
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
    <string>com.personal-automation.tasks</string>

    <key>ProgramArguments</key>
    <array>
        <string>${projectDir}/launchd/run-tasks-digest.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>

    <key>StandardOutPath</key>
    <string>${projectDir}/launchd/logs/tasks-digest.out.log</string>
    <key>StandardErrorPath</key>
    <string>${projectDir}/launchd/logs/tasks-digest.err.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`
}

/**
 * Builds the launchd agent plist for the due-date alert. One agent covers every pass: they run the
 * same command with the same arguments, and a `StartCalendarInterval` entry with no `Weekday` fires
 * every day.
 */
export function buildTasksAlertPlist({
  projectDir,
  times,
}: {
  projectDir: string
  times: TimeSlot[]
}): string {
  const intervals = times
    .map(
      slot => `    <dict>
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
    <string>com.personal-automation.tasks-alert</string>

    <key>ProgramArguments</key>
    <array>
        <string>${projectDir}/launchd/run-tasks-alert.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>

    <key>StandardOutPath</key>
    <string>${projectDir}/launchd/logs/tasks-alert.out.log</string>
    <key>StandardErrorPath</key>
    <string>${projectDir}/launchd/logs/tasks-alert.err.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`
}
