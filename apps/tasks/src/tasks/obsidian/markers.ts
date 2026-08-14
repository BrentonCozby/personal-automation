/**
 * Every Obsidian Tasks signifier emoji that can trail a task's description: the date markers
 * (created, due, scheduled, start, done, cancelled), the priorities, the id/blocking/onCompletion
 * tokens, and the recurrence rule.
 */
export const MARKER_CHARS = '➕📅⏳🛫✅❌🔺⏫🔼🔽⏬🆔⛔🏁🔁'

/** Matches the first signifier on a line, which is where the description ends. */
export const FIRST_MARKER = new RegExp(`[${MARKER_CHARS}]`, 'u')

const DONE_MARKER = /\s*✅\s*\d{4}-\d{2}-\d{2}/u
const CANCELLED_MARKER = /❌\s*\d{4}-\d{2}-\d{2}/u

/**
 * The same line with its `✅` date rewritten as an `❌` one.
 *
 * The Tasks plugin stamps `✅` for any status whose type is `DONE`, which includes the dropped
 * status, because that type is what makes dropping one occurrence of a recurring task still carry
 * its rule forward. The checkbox is what says a task was dropped rather than finished, so the date
 * marker beside it is corrected to agree.
 *
 * A line already carrying `❌` keeps that date and loses the `✅` one: two closing dates is a
 * contradiction, and the one written as a cancellation is the one that meant it.
 */
export function withDroppedMarker(line: string): string {
  if (!DONE_MARKER.test(line)) return line
  if (CANCELLED_MARKER.test(line)) return line.replace(DONE_MARKER, '')

  return line.replace('✅', '❌')
}
