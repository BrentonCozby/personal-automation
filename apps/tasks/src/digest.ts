import {
  escapeHtml,
  SANS_FONT_STACK as FONT_STACK,
  linkify,
  MONO_FONT_STACK,
} from '@personal-automation/common/html'
import type { Classification } from './anthropic/schemas.js'
import { CLI_INVOCATION, SUBJECT_PREFIX } from './constants.js'

/**
 * One analysis joined back to the task it was made about. Every number here is computed locally
 * rather than returned by the model, so nothing it wrote can contradict the figures printed beside
 * it.
 */
export type DigestItem = {
  title: string
  /** The list (file) the task lives on — shown so shared-list tasks (e.g. Family) are obvious. */
  list: string
  classification: Classification
  reasoning: string
  suggestedNextAction: string | null
  untouchedDays: number
  /** The task's own date, when it has already gone by. Null when it carries no date. */
  passedDueDate: string | null
}

export type Digest = {
  subject: string
  /** Plain-text body (the multipart fallback, and what `--dry-run` prints). */
  body: string
  /** HTML body — the richer rendering most mail clients show. */
  html: string
}

// "Quiet:"/"Do next:" labels pad to this column so their text lines up.
const LABEL_WIDTH = 10
const RULE = '═'.repeat(41)
const START_HERE_PREFIX = 'Start here →  '
const NO_ACTION = '(no single step — fit it into the right context.)'
const ALTERNATIVES = 'Or give it a date, or drop it:'

// A stand-in date for the printed command, not a recommendation: the point is a runnable line the
// reader edits. Well inside TASKS_HORIZON_DAYS, so pasting it as-is keeps the task active.
const SUGGESTED_DELAY = '+7d'

/**
 * The email for a set of tasks that have gone quiet. Renders what it is given: which tasks are quiet
 * and in what order is decided before this, so nothing here can disagree with the counts.
 */
export function buildDigest({
  items,
  activeCount,
}: {
  items: DigestItem[]
  activeCount: number
}): Digest {
  return {
    subject: `${SUBJECT_PREFIX} — ${items.length} ${items.length === 1 ? 'task has' : 'tasks have'} gone quiet`,
    body: renderBody({ items, activeCount }),
    html: renderHtml({ items, activeCount }),
  }
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
 * redirection, job control, history, and a leading `#` comment. Spaces are absent on purpose — the
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

function renderBody({ items, activeCount }: { items: DigestItem[]; activeCount: number }): string {
  const sections: string[] = []
  const pick = startHerePick(items)
  if (pick) sections.push(renderStartHere(pick))
  sections.push(summaryLine({ quiet: items.length, activeCount }))
  for (const item of items) sections.push(renderItem(item))

  return sections.join('\n\n')
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
    `  ${label('Quiet')}${quietFor(item.untouchedDays)} · ${item.classification} — ${item.reasoning}`,
  ]
  const note = dateNote(item)
  if (note) lines.push(`  ${valueIndent}${note}`)
  lines.push(`  ${label('Do next')}${item.suggestedNextAction ?? NO_ACTION}`)
  lines.push('', `  ${ALTERNATIVES}`, ...commandsFor(item).map(command => `    ${command}`))

  return lines.join('\n')
}

// --- HTML rendering (multipart alternative; the plain text above is the fallback) ---
// Email HTML must use inline styles (clients strip <style>/<head>), a web-safe font stack, and
// no external assets. Kept deliberately simple — divs + inline styles render reliably in Gmail.

const HTML_LABEL =
  'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#80868b;'
const QUIET_PILL =
  'display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:1px 7px;border-radius:10px;background:#e8eaed;color:#5f6368;margin-left:6px;vertical-align:middle;'
const COMMAND_BLOCK = `font-family:${MONO_FONT_STACK};font-size:12px;color:#3c4043;background:#f8f9fa;border-radius:4px;padding:8px 10px;margin-top:8px;white-space:pre-wrap;word-break:break-all;`

function renderHtml({ items, activeCount }: { items: DigestItem[]; activeCount: number }): string {
  const parts: string[] = []
  const pick = startHerePick(items)
  if (pick) parts.push(htmlStartHere(pick))
  parts.push(htmlSummary({ quiet: items.length, activeCount }))
  for (const item of items) parts.push(htmlItem(item))

  return `<div style="font-family:${FONT_STACK};max-width:560px;margin:0;padding:8px;color:#202124;font-size:15px;line-height:1.5;">${parts.join('')}</div>`
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

function htmlSummary({ quiet, activeCount }: { quiet: number; activeCount: number }): string {
  return `<div style="font-size:13px;color:#5f6368;margin:0 0 6px;">${escapeHtml(summaryLine({ quiet, activeCount }))}</div>`
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

  return `<div style="padding:14px 0;border-top:1px solid #ececec;"><div style="margin-bottom:6px;"><span style="font-size:16px;font-weight:600;">${escapeHtml(item.title)}</span><span style="${QUIET_PILL}">quiet ${escapeHtml(quietFor(item.untouchedDays))}</span><span style="font-size:13px;color:#80868b;"> · ${escapeHtml(item.list)}</span></div><div style="font-size:14px;color:#3c4043;margin-bottom:4px;">${escapeHtml(item.classification)} — ${escapeHtml(item.reasoning)}</div>${dateLine}<div style="font-size:14px;color:#202124;"><span style="${HTML_LABEL}">Do next</span>&nbsp;&nbsp;${action}</div><div style="font-size:13px;color:#5f6368;margin-top:10px;">${escapeHtml(ALTERNATIVES)}</div><div style="${COMMAND_BLOCK}">${commands}</div></div>`
}
