import type { OverrideEntry } from '../overrides.js'
import { calendarDaysBetween } from './days.js'

/** A cap raised often enough that the number itself is the thing to change. */
export type CapSuggestion = {
  /** How many times the cap now in force was raised inside the window. */
  overrideCount: number
  /** Days the count covers, so the email can name the span it is talking about. */
  windowDays: number
  /** One more than the most that was ever carried, so raising to it changes the name, not the load. */
  suggestedCap: number
}

/**
 * Whether the work-in-progress cap has been routed around often enough to suggest raising it, and
 * what to raise it to. Undefined when it has not.
 *
 * Only raises recorded against the cap now in force are counted, which is what makes acting on the
 * suggestion silence it: changing `TASKS_WIP_CAP` retires every entry written under the old value
 * and the count starts again from zero. Nothing has to remember that the suggestion was made.
 *
 * The window is `windowDays` calendar days counting today, and `limit` is a number of raises the
 * suggestion waits to be passed, not reached: a cap you go around exactly `limit` times is a cap
 * that mostly holds.
 */
export function suggestCapRaise({
  entries,
  cap,
  windowDays,
  limit,
  now,
}: {
  entries: readonly OverrideEntry[]
  cap: number
  windowDays: number
  limit: number
  now: Date
}): CapSuggestion | undefined {
  const raises = entries.filter(entry => {
    if (entry.cap !== cap) return false
    // A timestamp ahead of now is a hand edit rather than a raise. Counting it would let one bad
    // line hold the suggestion open for a month.
    const days = calendarDaysBetween({ from: new Date(entry.timestamp), to: now })

    return days >= 0 && days < windowDays
  })
  if (raises.length <= limit) return undefined

  // `active_count` is what was already active when the cap was raised, so one more than the largest
  // of them is the most that was actually carried.
  const carried = Math.max(...raises.map(entry => entry.active_count))

  return { overrideCount: raises.length, windowDays, suggestedCap: carried + 1 }
}
