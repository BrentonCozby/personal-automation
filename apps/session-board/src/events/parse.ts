import { hookEventSchema } from './schemas.js'
import type { ParsedEventLog } from './types.js'

/**
 * Turn raw event-log text into events, dropping any line that will not parse.
 *
 * Order is left exactly as written. The log is opened with O_APPEND by every
 * session at once, so the kernel serializes the writes and file order is the
 * real order. Sorting by `t` would be worse, not better: the timestamp has
 * one-second resolution, and a resume emits SessionEnd and SessionStart in the
 * same second. Deciding which came first from `t` alone is a coin flip, and the
 * pid-ownership rule in `liveness.ts` depends on getting it right.
 */
export function parseEventLog(text: string): ParsedEventLog {
  const events: ParsedEventLog['events'] = []
  let skippedLineCount = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      // Two writes large enough to interleave can tear a line, and a Claude
      // Code upgrade can reshape the payload. Neither is worth taking the
      // board down for, so the line is dropped and counted.
      skippedLineCount += 1
      continue
    }

    const parsed = hookEventSchema.safeParse(raw)
    if (!parsed.success) {
      skippedLineCount += 1
      continue
    }

    events.push(parsed.data)
  }

  return { events, skippedLineCount }
}
