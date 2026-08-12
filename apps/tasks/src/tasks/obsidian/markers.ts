/**
 * Every Obsidian Tasks signifier emoji that can trail a task's description: the date markers
 * (created, due, scheduled, start, done, cancelled), the priorities, the id/blocking/onCompletion
 * tokens, and the recurrence rule.
 */
export const MARKER_CHARS = '➕📅⏳🛫✅❌🔺⏫🔼🔽⏬🆔⛔🏁🔁'

/** Matches the first signifier on a line, which is where the description ends. */
export const FIRST_MARKER = new RegExp(`[${MARKER_CHARS}]`, 'u')
