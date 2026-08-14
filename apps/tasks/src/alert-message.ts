/** One task on today's push. */
export type DueItem = {
  title: string
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
}: {
  due: readonly DueItem[]
  demoted: readonly DemotedItem[]
}): AlertMessage {
  const dueLines = due.map(item => `${BULLET} ${item.title}`)
  const demotedLines =
    demoted.length === 0
      ? []
      : [
          `${MOVED_HEADING}:`,
          ...demoted.map(item => `${BULLET} ${item.title}, untouched ${item.untouchedDays} days`),
        ]

  // With nothing due, the push exists only to announce the demotion, so the title says so rather
  // than counting to zero.
  const title = due.length === 0 ? `${MOVED_HEADING} (${demoted.length})` : `Due (${due.length})`

  return {
    title,
    message: fitMessage({ dueLines, demotedLines }),
  }
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
  const dueOverflow = overflowed({ lines: dueLines, kept: 0, suffix: 'more' })
  for (let kept = demotedLines.length - 1; kept >= 2; kept -= 1) {
    const candidate = joined({
      dueLines: dueOverflow,
      demotedLines: overflowed({ lines: demotedLines, kept, suffix: 'more moved to someday' }),
    })
    if (byteLength(candidate) <= MESSAGE_LIMIT) return candidate
  }

  // The floor: one overflow line for each half, plus the heading. Every part of it is a fixed
  // string, so it fits whatever the tasks were called, and returning it beats a last candidate that
  // could only be the same thing.
  return joined({
    dueLines: dueOverflow,
    demotedLines: overflowed({ lines: demotedLines, kept: 1, suffix: 'more moved to someday' }),
  })
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
