import { AppError } from '@personal-automation/common/errors'
import { describe, expect, it } from 'vitest'
import {
  buildTasksAlertPlist,
  buildTasksDigestPlist,
  parseAlertTimes,
  parseSchedule,
} from './schedule.js'

describe('parseSchedule', () => {
  it('parses full day names into launchd weekday numbers + time', () => {
    const slots = parseSchedule(['Sunday 08:00', 'Wednesday 18:30'])

    expect(slots).toEqual([
      { day: 'Sunday', weekday: 0, hour: 8, minute: 0 },
      { day: 'Wednesday', weekday: 3, hour: 18, minute: 30 },
    ])
  })

  it('is case-insensitive on the day and tolerant of single-digit hours/whitespace', () => {
    const slots = parseSchedule(['  saturday 9:05 ', 'MONDAY 23:59'])

    expect(slots[0]).toEqual({ day: 'Saturday', weekday: 6, hour: 9, minute: 5 })
    expect(slots[1]).toEqual({ day: 'Monday', weekday: 1, hour: 23, minute: 59 })
  })

  it('throws on an empty schedule', () => {
    expect(() => parseSchedule([])).toThrow(AppError)
  })

  it('throws on a bad day name', () => {
    expect(() => parseSchedule(['Funday 08:00'])).toThrow(/Invalid day/)
  })

  it('throws on a malformed entry', () => {
    expect(() => parseSchedule(['Sunday'])).toThrow(/Expected/)
    expect(() => parseSchedule(['Sunday 8am'])).toThrow(/Expected/)
  })

  it('throws on an out-of-range time', () => {
    expect(() => parseSchedule(['Sunday 24:00'])).toThrow(/24-hour/)
    expect(() => parseSchedule(['Sunday 08:75'])).toThrow(/24-hour/)
  })
})

describe('buildTasksDigestPlist', () => {
  it('emits one StartCalendarInterval dict per slot with the project path', () => {
    const xml = buildTasksDigestPlist({
      projectDir: '/Users/me/Code/personal-automation',
      schedule: parseSchedule(['Sunday 08:00', 'Wednesday 18:30']),
    })

    expect(xml).toContain('<string>com.personal-automation.tasks</string>')
    expect(xml).toContain('/Users/me/Code/personal-automation/launchd/run-tasks-digest.sh')
    // Sunday 08:00
    expect(xml).toContain('<key>Weekday</key><integer>0</integer>')
    expect(xml).toContain('<key>Hour</key><integer>8</integer>')
    // Wednesday 18:30
    expect(xml).toContain('<key>Weekday</key><integer>3</integer>')
    expect(xml).toContain('<key>Minute</key><integer>30</integer>')
    const dictCount = xml.match(/<key>Weekday<\/key>/g) ?? []
    expect(dictCount.length).toBe(2)
  })
})

describe('parseAlertTimes', () => {
  it('parses 24-hour times', () => {
    expect(parseAlertTimes(['08:00', '19:30'])).toEqual([
      { hour: 8, minute: 0 },
      { hour: 19, minute: 30 },
    ])
  })

  it('rejects an empty list', () => {
    expect(() => parseAlertTimes([])).toThrow(AppError)
  })

  it('rejects a time that is not HH:MM', () => {
    expect(() => parseAlertTimes(['8am'])).toThrow(/8am/)
  })

  it('rejects an hour or minute out of range', () => {
    expect(() => parseAlertTimes(['24:00'])).toThrow(/24:00/)
    expect(() => parseAlertTimes(['08:60'])).toThrow(/08:60/)
  })
})

describe('buildTasksAlertPlist', () => {
  it('fires every day at each time, with no weekday', () => {
    const plist = buildTasksAlertPlist({
      projectDir: '/Users/me/personal-automation',
      times: [
        { hour: 8, minute: 0 },
        { hour: 19, minute: 0 },
      ],
    })

    expect(plist).toContain('<string>com.personal-automation.tasks-alert</string>')
    expect(plist).toContain('/Users/me/personal-automation/launchd/run-tasks-alert.sh')
    expect(plist).toContain('<key>Hour</key><integer>8</integer>')
    expect(plist).toContain('<key>Hour</key><integer>19</integer>')
    expect(plist).not.toContain('Weekday')
    expect(plist).toContain('launchd/logs/tasks-alert.err.log')
  })
})
