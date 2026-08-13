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
  const tail =
    demoted.length === 0
      ? []
      : [
          ...(dueLines.length > 0 ? [''] : []),
          `${MOVED_HEADING}:`,
          ...demoted.map(item => `${BULLET} ${item.title}, untouched ${item.untouchedDays} days`),
        ]

  return {
    title: titleFor({ due, demoted, now }),
    message: fitMessage({ dueLines, tail }),
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

// Whole lines are dropped from the end of the due list until the message fits, and the count that
// went is named. The demotion lines are never dropped: they are the only place that news appears.
function fitMessage({ dueLines, tail }: { dueLines: string[]; tail: string[] }): string {
  const full = [...dueLines, ...tail].join('\n')
  if (dueLines.length === 0 || byteLength(full) <= MESSAGE_LIMIT) return full

  for (let kept = dueLines.length - 1; kept > 0; kept -= 1) {
    const candidate = withOverflow({ dueLines, kept, tail })
    if (byteLength(candidate) <= MESSAGE_LIMIT) return candidate
  }

  return withOverflow({ dueLines, kept: 0, tail })
}

function withOverflow({
  dueLines,
  kept,
  tail,
}: {
  dueLines: string[]
  kept: number
  tail: string[]
}): string {
  return [...dueLines.slice(0, kept), `${BULLET} and ${dueLines.length - kept} more`, ...tail].join(
    '\n',
  )
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
