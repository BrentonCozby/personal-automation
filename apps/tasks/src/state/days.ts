const MS_PER_DAY = 86_400_000

// Either a full local date, or a count of days ahead of today. Anything else is not a date this
// app will guess at.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAYS_AHEAD = /^\+(\d+)d$/

/**
 * Whole calendar days from `from` to `to`, read in the machine's local time. Negative when the
 * range runs backwards.
 *
 * Every threshold in this app (the stall window, the decay horizon, the scheduling ceiling) is a
 * count of days a person would recognise, so a day is a calendar rollover rather than a 24-hour
 * span. Two timestamps eight hours apart across midnight are one day apart; two timestamps twenty
 * hours apart on the same date are zero.
 */
export function calendarDaysBetween({ from, to }: { from: Date; to: Date }): number {
  // Reading the local calendar date and rebuilding it in UTC drops the clock time and the offset
  // together, so daylight saving cannot reach the arithmetic. Subtracting the raw timestamps
  // instead loses an hour across a spring-forward, which floors a 30-day span to 29 and fires
  // every threshold check a day late.
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())

  return (end - start) / MS_PER_DAY
}

/**
 * A date as the vault writes it: `YYYY-MM-DD` in local time. `toISOString` would report the UTC
 * day, which is tomorrow's date on any evening in a negative-offset zone.
 */
export function localIsoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')

  return `${value.getFullYear()}-${month}-${day}`
}

/**
 * Whether the text is shaped like a date this app reads. Shape only: `2026-02-30` passes here and
 * is rejected by `parseTaskDate`, which is what lets the argument parser tell a mistyped date from
 * another word of the title without needing a clock.
 */
export function isTaskDateShape(input: string): boolean {
  return ISO_DATE.test(input) || DAYS_AHEAD.test(input)
}

/**
 * A date typed on the command line, as local midnight: either `YYYY-MM-DD` or `+Nd` days from
 * today. Undefined when the text isn't one of those, or names a day that doesn't exist.
 *
 * The round-trip check is what catches `2026-02-30`, which the Date constructor would silently
 * roll forward into March rather than reject.
 */
export function parseTaskDate({ input, now }: { input: string; now: Date }): Date | undefined {
  const ahead = input.match(DAYS_AHEAD)
  if (ahead) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(ahead[1]))
  }

  const parts = input.match(ISO_DATE)
  if (!parts) return undefined
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const date = new Date(year, month - 1, day)
  const isReal =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day

  return isReal ? date : undefined
}
