import {
  escapeHtml,
  SANS_FONT_STACK as FONT_STACK,
  linkify,
} from '@personal-automation/common/html'
import type { Classification, Priority } from './anthropic/schemas.js'
import { SUBJECT_PREFIX } from './constants.js'
import type { DueStatus } from './staleness.js'

/**
 * One analysis joined back to its locally-computed staleness + due signals. The model never
 * sees staleDays in its output (it's computed here), so ranking can't be hallucinated.
 */
export type DigestItem = {
  title: string
  /** The Reminders list the task lives on — shown so shared-list tasks (e.g. Family) are obvious. */
  list: string
  classification: Classification
  reasoning: string
  suggestedNextAction: string | null
  priority: Priority
  staleDays: number | null
  dueStatus: DueStatus
}

export type Digest = {
  /** Items shown in the action list (capped). Drives the subject and the no-email gate. */
  flaggedCount: number
  /** All stalled+actionable items before the cap — the tail the summary line conveys. */
  totalStalled: number
  /** The capped, ranked items actually rendered — same object refs passed in, so callers can flag which surfaced. */
  shown: DigestItem[]
  subject: string
  /** Plain-text body (the multipart fallback, and what `--dry-run` prints). */
  body: string
  /** HTML body — the richer rendering most mail clients show. */
  html: string
}

const PRIORITY_RANK: Record<Priority, number> = { high: 3, medium: 2, low: 1 }

// "Stuck:"/"Do next:" labels pad to this column so their text lines up.
const LABEL_WIDTH = 10
const RULE = '═'.repeat(41)
const START_HERE_PREFIX = 'Start here →  '

export function buildDigest({
  items,
  maxItems,
  staleThresholdDays,
}: {
  items: DigestItem[]
  maxItems: number
  staleThresholdDays: number
}): Digest {
  const habits = items.filter(i => i.classification === 'habit')
  const candidates = items.filter(i => isCandidate({ item: i, staleThresholdDays }))
  const ranked = [...candidates].sort(compareItems)
  const shown = ranked.slice(0, maxItems)

  const flaggedCount = shown.length
  const totalStalled = candidates.length
  const subject = `${SUBJECT_PREFIX} — ${flaggedCount} flagged`
  const body = renderBody({ shown, totalStalled, habits })
  const html = renderHtml({ shown, totalStalled, habits })

  return { flaggedCount, totalStalled, shown, subject, body, html }
}

// habit → footer, not the action list. fine = clear, no blocker → not worth nagging, EXCEPT
// when it's high priority (a safety issue or hard deadline): clear doesn't mean unimportant, so
// those still surface. future-due → Reminders' own alert has it; don't double-handle. Of the
// rest, only flag the genuinely stale: overdue, untouched past the threshold, or unknown age.
function isCandidate({
  item,
  staleThresholdDays,
}: {
  item: DigestItem
  staleThresholdDays: number
}): boolean {
  if (item.classification === 'habit') return false
  if (item.classification === 'fine' && item.priority !== 'high') return false
  if (item.dueStatus === 'future') return false
  if (item.dueStatus === 'past') return true
  if (item.staleDays === null) return true

  return item.staleDays >= staleThresholdDays
}

// priority desc, then overdue first, then staleDays desc (unknown staleness sorts last).
function compareItems(a: DigestItem, b: DigestItem): number {
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
    return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
  }
  const aPast = a.dueStatus === 'past' ? 1 : 0
  const bPast = b.dueStatus === 'past' ? 1 : 0
  if (aPast !== bPast) return bPast - aPast

  return (b.staleDays ?? -1) - (a.staleDays ?? -1)
}

function renderBody({
  shown,
  totalStalled,
  habits,
}: {
  shown: DigestItem[]
  totalStalled: number
  habits: DigestItem[]
}): string {
  const sections: string[] = []

  const top = shown[0]
  if (top) sections.push(renderStartHere({ shown, top }))
  sections.push(renderSummary({ shown: shown.length, totalStalled }))
  for (const item of shown) sections.push(renderItem(item))
  const footer = renderHabits(habits)
  if (footer) sections.push(footer)

  return sections.join('\n\n')
}

function renderStartHere({ shown, top }: { shown: DigestItem[]; top: DigestItem }): string {
  const pick = shown.find(i => i.suggestedNextAction) ?? top
  const indent = ' '.repeat(START_HERE_PREFIX.length)
  if (pick.suggestedNextAction) {
    return `${START_HERE_PREFIX}${pick.suggestedNextAction}\n${indent}(${pick.title} · ${pick.list})`
  }

  return `${START_HERE_PREFIX}${pick.title} · ${pick.list}\n${indent}${pick.reasoning}`
}

function renderSummary({ shown, totalStalled }: { shown: number; totalStalled: number }): string {
  if (totalStalled > shown) {
    return `${totalStalled} stalled total — here are the ${shown} that matter most right now.`
  }

  return `${totalStalled} stalled ${totalStalled === 1 ? 'task' : 'tasks'} right now.`
}

// A surfaced `fine` task isn't stuck (it's clear, just high-priority and undone), so "Stuck"
// would be contradictory — label its reason line "Status" instead.
function statusLabel(classification: Classification): string {
  return classification === 'fine' ? 'Status' : 'Stuck'
}

// Title stands alone on its line; the priority rides as a leading tag on the reason line, so
// nothing depends on a right-aligned column (which can't line up in Gmail's proportional font).
function renderItem(item: DigestItem): string {
  const header = `${item.title} · ${item.list}`
  const label = `${statusLabel(item.classification)}:`.padEnd(LABEL_WIDTH)
  const stuck = `${label}[${item.priority}] ${item.classification} — ${item.reasoning}`
  const action = item.suggestedNextAction ?? '(no single action — fit it into the right context.)'
  const doNext = `${'Do next:'.padEnd(LABEL_WIDTH)}${action}`

  return `${header}\n${RULE}\n  ${stuck}\n  ${doNext}`
}

function renderHabits(habits: DigestItem[]): string {
  if (habits.length === 0) return ''
  const lines = habits.map(h => `  • ${h.title} · ${h.list}  (anchor to a routine)`)

  return `Not really tasks — consider moving these out of Reminders:\n${lines.join('\n')}`
}

// --- HTML rendering (multipart alternative; the plain text above is the fallback) ---
// Email HTML must use inline styles (clients strip <style>/<head>), a web-safe font stack, and
// no external assets. Kept deliberately simple — divs + inline styles render reliably in Gmail.

const PRIORITY_PILL: Record<Priority, { bg: string; fg: string }> = {
  high: { bg: '#fce8e6', fg: '#c5221f' },
  medium: { bg: '#fef7e0', fg: '#b06000' },
  low: { bg: '#e8eaed', fg: '#5f6368' },
}

function renderHtml({
  shown,
  totalStalled,
  habits,
}: {
  shown: DigestItem[]
  totalStalled: number
  habits: DigestItem[]
}): string {
  const parts: string[] = []
  const top = shown[0]
  if (top) parts.push(htmlStartHere({ shown, top }))
  parts.push(htmlSummary({ shown: shown.length, totalStalled }))
  for (const item of shown) parts.push(htmlItem(item))
  const footer = htmlHabits(habits)
  if (footer) parts.push(footer)

  return `<div style="font-family:${FONT_STACK};max-width:560px;margin:0;padding:8px;color:#202124;font-size:15px;line-height:1.5;">${parts.join('')}</div>`
}

function htmlStartHere({ shown, top }: { shown: DigestItem[]; top: DigestItem }): string {
  const pick = shown.find(i => i.suggestedNextAction) ?? top
  const lead = pick.suggestedNextAction
    ? linkify(escapeHtml(pick.suggestedNextAction))
    : escapeHtml(pick.title)
  const sub = pick.suggestedNextAction
    ? `${escapeHtml(pick.title)} · ${escapeHtml(pick.list)}`
    : escapeHtml(pick.reasoning)

  return `<div style="background:#eef4ff;border-left:4px solid #1a73e8;border-radius:6px;padding:14px 16px;margin:0 0 20px;"><div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#1a73e8;margin-bottom:4px;">Start here</div><div style="font-size:16px;font-weight:600;">${lead}</div><div style="font-size:13px;color:#5f6368;margin-top:2px;">${sub}</div></div>`
}

function htmlSummary({ shown, totalStalled }: { shown: number; totalStalled: number }): string {
  const text =
    totalStalled > shown
      ? `${totalStalled} stalled total — here are the ${shown} that matter most right now.`
      : `${totalStalled} stalled ${totalStalled === 1 ? 'task' : 'tasks'} right now.`

  return `<div style="font-size:13px;color:#5f6368;margin:0 0 6px;">${escapeHtml(text)}</div>`
}

// Shared micro-label style so "Stuck"/"Do next" match the "Start here" callout's label.
const HTML_LABEL =
  'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#80868b;'

function htmlItem(item: DigestItem): string {
  const pill = PRIORITY_PILL[item.priority]
  const action = item.suggestedNextAction
    ? `<span style="font-weight:500;">${linkify(escapeHtml(item.suggestedNextAction))}</span>`
    : '<span style="color:#80868b;">(no single action — fit it into the right context)</span>'

  return `<div style="padding:14px 0;border-top:1px solid #ececec;"><div style="margin-bottom:6px;"><span style="font-size:16px;font-weight:600;">${escapeHtml(item.title)}</span><span style="display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:1px 7px;border-radius:10px;background:${pill.bg};color:${pill.fg};margin-left:6px;vertical-align:middle;">${item.priority}</span><span style="font-size:13px;color:#80868b;"> · ${escapeHtml(item.list)}</span></div><div style="font-size:14px;color:#3c4043;margin-bottom:4px;"><span style="${HTML_LABEL}">${statusLabel(item.classification)}</span>&nbsp;&nbsp;${escapeHtml(item.classification)} — ${escapeHtml(item.reasoning)}</div><div style="font-size:14px;color:#202124;"><span style="${HTML_LABEL}">Do next</span>&nbsp;&nbsp;${action}</div></div>`
}

function htmlHabits(habits: DigestItem[]): string {
  if (habits.length === 0) return ''
  const items = habits
    .map(
      h =>
        `<li style="margin-bottom:3px;">${escapeHtml(h.title)} · ${escapeHtml(h.list)} <span style="color:#9aa0a6;">(anchor to a routine)</span></li>`,
    )
    .join('')

  return `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #ececec;font-size:13px;color:#5f6368;"><div style="margin-bottom:6px;">Not really tasks — consider moving these out of Reminders:</div><ul style="margin:0;padding-left:18px;">${items}</ul></div>`
}
