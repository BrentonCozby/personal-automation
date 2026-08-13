import { clearStateTags } from './tags.js'

const DUE_DATE = /📅\s*\d{4}-\d{2}-\d{2}/u
const CANCELLED_DATE = /❌\s*\d{4}-\d{2}-\d{2}/u
// The checkbox of a task line: indentation, a bullet, then the single character inside the
// brackets. Captured in three parts so only the character is replaced.
const CHECKBOX = /^(\s*[-*+]\s+\[)(.)(\])/u

/**
 * The line with its due date set to `date` (a local `YYYY-MM-DD`), replacing any date already
 * there. A line with no due date gets one appended after its other markers, which the Tasks plugin
 * reads the same way — it parses markers wherever they sit and rewrites them in its own order.
 */
export function withDueDate({ line, date }: { line: string; date: string }): string {
  const marker = `📅 ${date}`
  if (DUE_DATE.test(line)) return line.replace(DUE_DATE, marker)

  return `${line.trimEnd()} ${marker}`
}

/**
 * The line rewritten as a cancelled task: Obsidian's cancelled checkbox, the plugin's `❌` date,
 * and no state tag.
 *
 * The checkbox is the record. A tag beside it would state the same fact twice, and on a reusable
 * checklist it would freeze this run's ticks into the template.
 */
export function asCancelled({ line, date }: { line: string; date: string }): string {
  const cancelled = clearStateTags(line).replace(CHECKBOX, '$1-$3')
  const marker = `❌ ${date}`
  if (CANCELLED_DATE.test(cancelled)) return cancelled.replace(CANCELLED_DATE, marker)

  return `${cancelled.trimEnd()} ${marker}`
}
