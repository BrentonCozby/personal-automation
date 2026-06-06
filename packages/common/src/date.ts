export function isoDateNDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)

  return d.toISOString().slice(0, 10)
}

// UTC YYYY-MM-DD, used as a key rather than for display: audit/run-log filenames and the
// model's "today". Writer and reader (createLogger and notify) both call this, so the date
// can't drift between them regardless of the machine's timezone. Human-facing dates are
// formatted in local time at the render site instead.
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
