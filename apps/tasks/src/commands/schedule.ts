import { calendarDaysBetween, localIsoDate, parseTaskDate } from '../state/days.js'
import { defaultTouchClockPath } from '../state/touch-clock.js'
import { withDueDate } from '../tasks/obsidian/edits.js'
import { withStateTag } from '../tasks/obsidian/tags.js'
import {
  findMatches,
  type LookupFailure,
  type NotEditable,
  notEditable,
  summarize,
  touchFor,
  type WriteFailure,
  withTaskClock,
  writeTaskLine,
} from './task-edit.js'

export type ScheduleResult =
  | LookupFailure
  | WriteFailure
  | NotEditable
  | { kind: 'bad_date'; input: string }
  | { kind: 'past_date'; input: string; date: string }
  | {
      kind: 'scheduled'
      title: string
      list: string
      date: string
      /** True when the date sat past the horizon, so the task was moved to `#someday`. */
      isDeferred: boolean
      horizonDays: number
    }

/**
 * Puts a date on one task.
 *
 * A date inside the horizon keeps the task where it is, holding its place on the active list if it
 * had one: naming a day inside the next few weeks is a commitment, not a deferral. A date beyond
 * the horizon is not a plan, so the task is moved to `#someday` and the message says so; if it was
 * active, that frees its place.
 *
 * Scheduling counts as a touch, which is what lets it answer a stalled task.
 */
export async function runSchedule({
  vaultPath,
  scopes,
  query,
  dateInput,
  horizonDays,
  now = new Date(),
  clockPath = defaultTouchClockPath(),
}: {
  vaultPath: string
  scopes: readonly string[]
  query: string
  dateInput: string
  horizonDays: number
  now?: Date
  clockPath?: string
}): Promise<ScheduleResult> {
  return await withTaskClock<ScheduleResult>({
    vaultPath,
    scopes,
    clockPath,
    now,
    act: async ({ open, clock }) => {
      const date = parseTaskDate({ input: dateInput, now })
      if (!date) return { result: { kind: 'bad_date', input: dateInput }, clock }

      const daysAhead = calendarDaysBetween({ from: now, to: date })
      if (daysAhead < 0) {
        return {
          result: { kind: 'past_date', input: dateInput, date: localIsoDate(date) },
          clock,
        }
      }

      const [task, ...rest] = findMatches({ open, query })
      if (!task) return { result: { kind: 'not_found', query }, clock }
      if (rest.length > 0) {
        const matches = [task, ...rest].map(match => summarize({ task: match, clock }))

        return { result: { kind: 'ambiguous', query, matches }, clock }
      }

      const blocked = notEditable(task)
      if (blocked) return { result: blocked, clock }

      const iso = localIsoDate(date)
      const dated = withDueDate({ line: task.lineText, date: iso })
      const isDeferred = daysAhead > horizonDays
      const after = isDeferred ? withStateTag({ line: dated, state: 'someday' }) : dated
      if (!(await writeTaskLine({ vaultPath, task, after }))) {
        return { result: { kind: 'conflict', title: task.title, path: task.path }, clock }
      }

      return {
        result: {
          kind: 'scheduled',
          title: task.title,
          list: task.list,
          date: iso,
          isDeferred,
          horizonDays,
        },
        clock: touchFor({ clock, task, after, now }),
      }
    },
  })
}
