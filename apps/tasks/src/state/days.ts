const MS_PER_DAY = 86_400_000

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
