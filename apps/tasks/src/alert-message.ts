import { localIsoDate } from './state/days.js'

/** One task on today's push. `due` is null only on a task no rule here can reach. */
export type DueItem = {
  title: string
  due: Date | null
}

/** One task the pass demoted, and how long it had been sitting. */
export type DemotedItem = {
  title: string
  untouchedDays: number
}

export type AlertMessage = {
  title: string
  message: string
}

// Pushover's own limits, in UTF-8 bytes. Anything longer is cut by their API, mid-word.
const MESSAGE_LIMIT = 1024
// Items are separated by a bullet because Pushover strips HTML from the notification and shows the
// message as one run of text there, where newlines alone do not read as separate items. The banner
// is the only part that has to be readable; the app renders the newlines as a list.
const BULLET = '•'
const MOVED_HEADING = 'Moved to someday'

/**
 * The push: what is due, and anything the pass demoted.
 *
 * Renders what it is given. Whether any of this is worth sending is decided before this, so nothing
 * here can disagree with the counts.
 */
export function buildAlertMessage({
  due,
  demoted,
  now,
}: {
  due: readonly DueItem[]
  demoted: readonly DemotedItem[]
  now: Date
}): AlertMessage {
  const dueLines = due.map(item => `${BULLET} ${item.title}`)
  const demotedLines =
    demoted.length === 0
      ? []
      : [
          `${MOVED_HEADING}:`,
          ...demoted.map(item => `${BULLET} ${item.title}, untouched ${item.untouchedDays} days`),
        ]

  return {
    title: titleFor({ due, demoted, now }),
    message: fitMessage({ dueLines, demotedLines }),
  }
}

// A list dated today is the common case (the chores), so it gets the plainer wording. Anything older
// on the list makes "today" untrue, and this text is read on a lock screen with nothing to check it
// against.
function titleFor({
  due,
  demoted,
  now,
}: {
  due: readonly DueItem[]
  demoted: readonly DemotedItem[]
  now: Date
}): string {
  if (due.length === 0) return `${MOVED_HEADING} (${demoted.length})`
  const today = localIsoDate(now)
  const isAllToday = due.every(item => item.due !== null && localIsoDate(item.due) === today)

  return `${isAllToday ? 'Due today' : 'Due or overdue'} (${due.length})`
}

// Whole lines are dropped until the message fits, and the count that went is named, so nothing is
// ever shown half-written. The due list is trimmed first: a demotion appears on no other channel,
// so it survives until trimming the whole due list is still not enough.
function fitMessage({
  dueLines,
  demotedLines,
}: {
  dueLines: string[]
  demotedLines: string[]
}): string {
  const full = joined({ dueLines, demotedLines })
  if (byteLength(full) <= MESSAGE_LIMIT) return full

  for (let kept = dueLines.length - 1; kept >= 0; kept -= 1) {
    const candidate = joined({
      dueLines: overflowed({ lines: dueLines, kept, suffix: 'more' }),
      demotedLines,
    })
    if (byteLength(candidate) <= MESSAGE_LIMIT) return candidate
  }

  // Reached only when the demotion list fills the message on its own. Its heading is line one, so
  // trimming stops at one line rather than zero.
  for (let kept = demotedLines.length - 1; kept >= 1; kept -= 1) {
    const candidate = joined({
      dueLines: overflowed({ lines: dueLines, kept: 0, suffix: 'more' }),
      demotedLines: overflowed({
        lines: demotedLines,
        kept,
        suffix: 'more moved to someday',
      }),
    })
    if (byteLength(candidate) <= MESSAGE_LIMIT) return candidate
  }

  return `${MOVED_HEADING}: ${demotedLines.length} tasks`
}

// The lines that survived, plus one line naming how many did not. An empty list stays empty rather
// than becoming a count of nothing.
function overflowed({
  lines,
  kept,
  suffix,
}: {
  lines: string[]
  kept: number
  suffix: string
}): string[] {
  if (lines.length === 0) return []
  const dropped = lines.length - kept
  if (dropped <= 0) return [...lines]

  return [...lines.slice(0, kept), `${BULLET} and ${dropped} ${suffix}`]
}

// The blank line between the halves belongs to neither of them, so it is added here rather than
// carried inside one of the lists, where trimming could drop it or leave it stranded.
function joined({
  dueLines,
  demotedLines,
}: {
  dueLines: string[]
  demotedLines: string[]
}): string {
  const separator = dueLines.length > 0 && demotedLines.length > 0 ? [''] : []

  return [...dueLines, ...separator, ...demotedLines].join('\n')
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
