import {
  escapeHtml,
  SANS_FONT_STACK as FONT_STACK,
  linkify,
  MONO_FONT_STACK,
} from '@personal-automation/common/html'
import type { Classification } from './anthropic/schemas.js'
import { CLI_INVOCATION, SUBJECT_PREFIX } from './constants.js'
import { localIsoDate } from './state/days.js'
import type { DoneEntry, DoneList } from './state/done.js'

/**
 * One analysis joined back to the task it was made about. Every number here is computed locally
 * rather than returned by the model, so nothing it wrote can contradict the figures printed beside
 * it.
 */
export type DigestItem = {
  title: string
  /** The list (file) the task lives on. Shown so shared-list tasks (e.g. Family) are obvious. */
  list: string
  classification: Classification
  reasoning: string
  suggestedNextAction: string | null
  untouchedDays: number
  /** The task's own date, when it has already gone by. Null when it carries no date. */
  passedDueDate: string | null
}

/** The done list plus the one progress signal the vault holds for work nobody has finished yet. */
export type DoneSummary = DoneList & {
  /** How many days the list covers, counting today. */
  windowDays: number
  /** How many of the tasks being carried were touched inside the same window. */
  movedCount: number
}

export type Digest = {
  subject: string
  /** Plain-text body (the multipart fallback, and what `--dry-run` prints). */
  body: string
  /** HTML body: the richer rendering most mail clients show. */
  html: string
}

// "Quiet:"/"Do next:" labels pad to this column so their text lines up.
const LABEL_WIDTH = 10
const RULE = '═'.repeat(41)
const START_HERE_PREFIX = 'Start here →  '
const NO_ACTION = '(no single step; fit it into the right context.)'
const ALTERNATIVES = 'Or give it a date, or drop it:'
const NOTHING_QUIET = 'Nothing has gone quiet. Here is what the last few days produced.'

// A stand-in date for the printed command, not a recommendation: the point is a runnable line the
// reader edits. Well inside TASKS_HORIZON_DAYS, so pasting it as-is keeps the task active.
const SUGGESTED_DELAY = '+7d'

/**
 * The email: the tasks that have gone quiet, and the record of what the last few days produced.
 *
 * Renders what it is given. Which tasks are quiet, in what order, and whether any of this is worth
 * sending are all decided before this, so nothing here can disagree with the counts.
 *
 * With no quiet tasks it renders the done list on its own, which is the whole point of keeping one:
 * a to-do list can only ever show you the shortfall, so the record of what you did has to be able to
 * arrive without anything being wrong.
 */
export function buildDigest({
  items,
  activeCount,
  done,
}: {
  items: DigestItem[]
  activeCount: number
  done: DoneSummary
}): Digest {
  return {
    subject: subjectFor({ items, done }),
    body: renderBody({ items, activeCount, done }),
    html: renderHtml({ items, activeCount, done }),
  }
}

function subjectFor({ items, done }: { items: DigestItem[]; done: DoneSummary }): string {
  if (items.length > 0) {
    return `${SUBJECT_PREFIX}: ${items.length} ${items.length === 1 ? 'task has' : 'tasks have'} gone quiet`
  }
  const counts = [
    done.finishedCount > 0 ? `${done.finishedCount} finished` : '',
    done.droppedCount > 0 ? `${done.droppedCount} dropped` : '',
  ].filter(Boolean)

  return `${SUBJECT_PREFIX}: ${counts.join(', ')}`
}

function summaryLine({ quiet, activeCount }: { quiet: number; activeCount: number }): string {
  if (quiet < activeCount) {
    return `${quiet} of the ${activeCount} tasks you are carrying ${quiet === 1 ? 'has' : 'have'} gone quiet.`
  }
  if (activeCount === 1) return 'The one task you are carrying has gone quiet.'
  if (activeCount === 2) return 'Both of the tasks you are carrying have gone quiet.'

  return `All ${activeCount} of the tasks you are carrying have gone quiet.`
}

function quietFor(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * The order note, or undefined when there is only one task and so no order to explain.
 *
 * The order has to be named wherever it is shown, because the proxy for "nearly done" is momentum
 * rather than any measure of progress, and an unexplained order invites the reader to invent one.
 */
function orderNote(items: DigestItem[]): string | undefined {
  if (items.length < 2) return undefined

  return 'Nearest done first, going by what you touched last.'
}

function dateNote(item: DigestItem): string | undefined {
  if (!item.passedDueDate) return undefined

  return `Its date, ${item.passedDueDate}, has gone by.`
}

/** The two commands offered beside each quiet task, ready to paste from the repo root. */
function commandsFor(item: DigestItem): string[] {
  const title = shellArgument(item.title)

  return [
    `${CLI_INVOCATION} schedule ${title} ${SUGGESTED_DELAY}`,
    `${CLI_INVOCATION} abandon ${title}`,
  ]
}

/**
 * Characters a shell would act on rather than pass through: quoting, expansion, globbing,
 * redirection, job control, history, and a leading `#` comment. Spaces are absent on purpose: the
 * CLI joins its remaining arguments, so a multi-word title needs no quoting.
 */
const SHELL_SPECIAL = /[!"#$&'()*;<>?[\\\]`{|}~]/

/**
 * The title as a shell argument: bare when nothing in it needs quoting, which is the ordinary case
 * and the form the README documents.
 */
function shellArgument(text: string): string {
  if (!SHELL_SPECIAL.test(text)) return text

  // Single quotes protect everything except a single quote, which has to close the quoting, be
  // escaped, and reopen it. Without that the pasted line would not run.
  return `'${text.replaceAll("'", "'\\''")}'`
}

// The first item that has a next step, so the lead line is always something to do. Ordering is the
// caller's, so this only ever moves past an item the model could name no single step for.
function startHerePick(items: DigestItem[]): DigestItem | undefined {
  return items.find(item => item.suggestedNextAction) ?? items[0]
}

function renderBody({
  items,
  activeCount,
  done,
}: {
  items: DigestItem[]
  activeCount: number
  done: DoneSummary
}): string {
  const sections: string[] = []
  if (items.length === 0) {
    sections.push(NOTHING_QUIET)
  } else {
    const pick = startHerePick(items)
    if (pick) sections.push(renderStartHere(pick))
    const note = orderNote(items)
    sections.push(
      note
        ? `${summaryLine({ quiet: items.length, activeCount })}\n${note}`
        : summaryLine({ quiet: items.length, activeCount }),
    )
    for (const item of items) sections.push(renderItem(item))
  }
  const record = renderDone({ done, activeCount })
  if (record) sections.push(record)

  return sections.join('\n\n')
}

// The counts, then the list itself. A count of zero is left out rather than printed as a zero: the
// point of the section is what happened, and a row of noughts reads as a scorecard.
function renderDone({
  done,
  activeCount,
}: {
  done: DoneSummary
  activeCount: number
}): string | undefined {
  const counts = doneCounts({ done, activeCount })
  if (counts.length === 0) return undefined
  const lines = [doneHeading(done.windowDays), RULE, ...counts.map(count => `  ${count}`)]
  const entries = [
    ...done.finished.map(task => doneEntryLine({ task, mark: '✓' })),
    ...done.dropped.map(task => doneEntryLine({ task, mark: '✗' })),
  ]
  if (entries.length > 0) lines.push('', ...entries.map(line => `  ${line}`))

  return lines.join('\n')
}

function doneCounts({ done, activeCount }: { done: DoneSummary; activeCount: number }): string[] {
  const counts: string[] = []
  if (done.finishedCount > 0) counts.push(`${label('Finished')}${done.finishedCount}`)
  if (done.droppedCount > 0) {
    counts.push(`${label('Dropped')}${done.droppedCount}  (chosen, not missed)`)
  }
  // Nothing to say about movement when nothing is being carried, and nothing worth a line when
  // none of it moved.
  if (activeCount > 0 && done.movedCount > 0) {
    counts.push(`${label('Moved')}${done.movedCount} of the ${activeCount} you are carrying`)
  }

  return counts
}

function doneHeading(windowDays: number): string {
  return `The last ${windowDays} days`
}

function doneEntryLine({ task, mark }: { task: DoneEntry; mark: string }): string {
  return `${mark} ${localIsoDate(task.closed)}  ${task.title}${repeats(task)}`
}

// A recurring chore done more than once in the window is one line carrying its count, with the date
// of the most recent time.
function repeats(task: DoneEntry): string {
  return task.times > 1 ? `  (×${task.times})` : ''
}

function renderStartHere(pick: DigestItem): string {
  const indent = ' '.repeat(START_HERE_PREFIX.length)
  if (pick.suggestedNextAction) {
    return `${START_HERE_PREFIX}${pick.suggestedNextAction}\n${indent}(${pick.title} · ${pick.list})`
  }

  return `${START_HERE_PREFIX}${pick.title} · ${pick.list}\n${indent}${pick.reasoning}`
}

function label(text: string): string {
  return `${text}:`.padEnd(LABEL_WIDTH)
}

function renderItem(item: DigestItem): string {
  const valueIndent = ' '.repeat(LABEL_WIDTH)
  const lines = [
    `${item.title} · ${item.list}`,
    RULE,
    `  ${label('Quiet')}${quietFor(item.untouchedDays)} · ${item.classification}: ${item.reasoning}`,
  ]
  const note = dateNote(item)
  if (note) lines.push(`  ${valueIndent}${note}`)
  lines.push(`  ${label('Do next')}${item.suggestedNextAction ?? NO_ACTION}`)
  lines.push('', `  ${ALTERNATIVES}`, ...commandsFor(item).map(command => `    ${command}`))

  return lines.join('\n')
}

// --- HTML rendering (multipart alternative; the plain text above is the fallback) ---
// Email HTML must use inline styles (clients strip <style>/<head>), a web-safe font stack, and
// no external assets. Kept deliberately simple: divs + inline styles render reliably in Gmail.

const HTML_LABEL =
  'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#80868b;'
const QUIET_PILL =
  'display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:1px 7px;border-radius:10px;background:#e8eaed;color:#5f6368;margin-left:6px;vertical-align:middle;'
const COMMAND_BLOCK = `font-family:${MONO_FONT_STACK};font-size:12px;color:#3c4043;background:#f8f9fa;border-radius:4px;padding:8px 10px;margin-top:8px;white-space:pre-wrap;word-break:break-all;`

function renderHtml({
  items,
  activeCount,
  done,
}: {
  items: DigestItem[]
  activeCount: number
  done: DoneSummary
}): string {
  const parts: string[] = []
  if (items.length === 0) {
    parts.push(`<div style="font-size:15px;margin:0 0 6px;">${escapeHtml(NOTHING_QUIET)}</div>`)
  } else {
    const pick = startHerePick(items)
    if (pick) parts.push(htmlStartHere(pick))
    parts.push(htmlSummary({ items, activeCount }))
    for (const item of items) parts.push(htmlItem(item))
  }
  const record = htmlDone({ done, activeCount })
  if (record) parts.push(record)

  return `<div style="font-family:${FONT_STACK};max-width:560px;margin:0;padding:8px;color:#202124;font-size:15px;line-height:1.5;">${parts.join('')}</div>`
}

function htmlDone({
  done,
  activeCount,
}: {
  done: DoneSummary
  activeCount: number
}): string | undefined {
  const counts = doneCounts({ done, activeCount })
  if (counts.length === 0) return undefined
  const countLines = counts
    .map(count => `<div>${escapeHtml(count.replace(/\s+/g, ' ').trim())}</div>`)
    .join('')
  const entries = [
    ...done.finished.map(task => ({ task, mark: '✓', color: '#188038' })),
    ...done.dropped.map(task => ({ task, mark: '✗', color: '#80868b' })),
  ]
    .map(
      ({ task, mark, color }) =>
        `<li style="margin-bottom:3px;"><span style="color:${color};">${mark}</span> <span style="color:#80868b;">${localIsoDate(task.closed)}</span> ${escapeHtml(task.title)}<span style="color:#80868b;">${escapeHtml(repeats(task))}</span></li>`,
    )
    .join('')
  const list = entries ? `<ul style="margin:6px 0 0;padding-left:18px;">${entries}</ul>` : ''

  return `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #ececec;"><div style="${HTML_LABEL}">${escapeHtml(doneHeading(done.windowDays))}</div><div style="font-size:14px;color:#3c4043;margin-top:6px;">${countLines}</div><div style="font-size:14px;">${list}</div></div>`
}

function htmlStartHere(pick: DigestItem): string {
  const lead = pick.suggestedNextAction
    ? linkify(escapeHtml(pick.suggestedNextAction))
    : escapeHtml(pick.title)
  const sub = pick.suggestedNextAction
    ? `${escapeHtml(pick.title)} · ${escapeHtml(pick.list)}`
    : escapeHtml(pick.reasoning)

  return `<div style="background:#eef4ff;border-left:4px solid #1a73e8;border-radius:6px;padding:14px 16px;margin:0 0 20px;"><div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#1a73e8;margin-bottom:4px;">Start here</div><div style="font-size:16px;font-weight:600;">${lead}</div><div style="font-size:13px;color:#5f6368;margin-top:2px;">${sub}</div></div>`
}

function htmlSummary({ items, activeCount }: { items: DigestItem[]; activeCount: number }): string {
  const note = orderNote(items)
  const noteLine = note ? ` ${escapeHtml(note)}` : ''

  return `<div style="font-size:13px;color:#5f6368;margin:0 0 6px;">${escapeHtml(summaryLine({ quiet: items.length, activeCount }))}${noteLine}</div>`
}

function htmlItem(item: DigestItem): string {
  const action = item.suggestedNextAction
    ? `<span style="font-weight:500;">${linkify(escapeHtml(item.suggestedNextAction))}</span>`
    : `<span style="color:#80868b;">${escapeHtml(NO_ACTION)}</span>`
  const note = dateNote(item)
  const dateLine = note
    ? `<div style="font-size:13px;color:#5f6368;margin-bottom:4px;">${escapeHtml(note)}</div>`
    : ''
  const commands = commandsFor(item).map(escapeHtml).join('\n')

  return `<div style="padding:14px 0;border-top:1px solid #ececec;"><div style="margin-bottom:6px;"><span style="font-size:16px;font-weight:600;">${escapeHtml(item.title)}</span><span style="${QUIET_PILL}">quiet ${escapeHtml(quietFor(item.untouchedDays))}</span><span style="font-size:13px;color:#80868b;"> · ${escapeHtml(item.list)}</span></div><div style="font-size:14px;color:#3c4043;margin-bottom:4px;">${escapeHtml(item.classification)}: ${escapeHtml(item.reasoning)}</div>${dateLine}<div style="font-size:14px;color:#202124;"><span style="${HTML_LABEL}">Do next</span>&nbsp;&nbsp;${action}</div><div style="font-size:13px;color:#5f6368;margin-top:10px;">${escapeHtml(ALTERNATIVES)}</div><div style="${COMMAND_BLOCK}">${commands}</div></div>`
}
