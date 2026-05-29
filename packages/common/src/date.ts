export function isoDateNDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)

  return d.toISOString().slice(0, 10)
}

// Local-date YYYY-MM-DD so audit file rollover and any reader of those files agree on
// the user's wall clock. Both the writer (createLogger) and the reader (notify) call
// this so the date format can't drift.
export function todayLocalIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')

  return `${y}-${m}-${day}`
}
