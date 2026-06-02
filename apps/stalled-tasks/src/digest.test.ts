import { expect, it } from 'vitest'
import { buildDigest, type Digest, type DigestItem } from './digest.js'

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    title: 'a task',
    list: 'Reminders',
    classification: 'aversion',
    reasoning: 'because reasons',
    suggestedNextAction: 'do the next thing',
    priority: 'medium',
    staleDays: 40,
    dueStatus: 'none',
    ...overrides,
  }
}

function build(items: DigestItem[]): Digest {
  return buildDigest({ items, maxItems: 5, staleThresholdDays: 30 })
}

it('drops fine tasks from both the action list and the stalled count', () => {
  const digest = build([
    item({ title: 'stuck', classification: 'aversion' }),
    item({ title: 'just undone', classification: 'fine' }),
  ])

  expect(digest.flaggedCount).toBe(1)
  expect(digest.totalStalled).toBe(1)
  expect(digest.body).toContain('stuck')
  expect(digest.body).not.toContain('just undone')
})

it('surfaces a high-priority fine task (safety/deadline) but still drops low/medium fine tasks', () => {
  const digest = build([
    item({ title: 'secure furniture', classification: 'fine', priority: 'high', staleDays: 60 }),
    item({ title: 'water cooler', classification: 'fine', priority: 'medium', staleDays: 60 }),
  ])

  expect(digest.flaggedCount).toBe(1)
  expect(digest.body).toContain('secure furniture')
  expect(digest.body).not.toContain('water cooler')
  // A surfaced fine task reads "Status", not the contradictory "Stuck".
  expect(digest.body).toContain('Status:')
  expect(digest.body).not.toContain('Stuck:')
})

it('routes habits to the footer, not the action list or the stalled count', () => {
  const digest = build([
    item({ title: 'real task', classification: 'aversion' }),
    item({ title: 'meditate daily', classification: 'habit', suggestedNextAction: null }),
  ])

  expect(digest.flaggedCount).toBe(1)
  expect(digest.totalStalled).toBe(1)
  expect(digest.body).toContain('Not really tasks — consider moving these out of Reminders:')
  expect(digest.body).toContain('• meditate daily · Reminders  (anchor to a routine)')
})

it('drops tasks with a future due date (scheduled, not stalled)', () => {
  const digest = build([
    item({ title: 'scheduled', dueStatus: 'future', staleDays: 200 }),
    item({ title: 'stalled', dueStatus: 'none' }),
  ])

  expect(digest.flaggedCount).toBe(1)
  expect(digest.body).toContain('stalled')
  expect(digest.body).not.toContain('scheduled')
})

it('excludes tasks fresher than the staleness threshold', () => {
  const digest = build([
    item({ title: 'fresh', staleDays: 5, dueStatus: 'none' }),
    item({ title: 'old', staleDays: 60, dueStatus: 'none' }),
  ])

  expect(digest.flaggedCount).toBe(1)
  expect(digest.body).toContain('old')
  expect(digest.body).not.toContain('fresh')
})

it('includes an overdue task even when it is fresher than the threshold', () => {
  const digest = build([item({ title: 'overdue but fresh', staleDays: 2, dueStatus: 'past' })])

  expect(digest.flaggedCount).toBe(1)
  expect(digest.body).toContain('overdue but fresh')
})

it('includes a task with unknown staleness', () => {
  const digest = build([item({ title: 'unknown age', staleDays: null, dueStatus: 'none' })])

  expect(digest.flaggedCount).toBe(1)
})

it('ranks high priority before medium before low', () => {
  const digest = build([
    item({ title: 'lowp', priority: 'low' }),
    item({ title: 'highp', priority: 'high' }),
    item({ title: 'medp', priority: 'medium' }),
  ])

  expect(digest.shown.map(i => i.title)).toEqual(['highp', 'medp', 'lowp'])
})

it('ranks overdue ahead of non-overdue at the same priority', () => {
  const digest = build([
    item({ title: 'not-due', priority: 'medium', dueStatus: 'none', staleDays: 90 }),
    item({ title: 'overdue', priority: 'medium', dueStatus: 'past', staleDays: 10 }),
  ])

  expect(digest.shown.map(i => i.title)).toEqual(['overdue', 'not-due'])
})

it('ranks by staleDays descending at the same priority and due status', () => {
  const digest = build([
    item({ title: 'newer', priority: 'low', staleDays: 35, dueStatus: 'none' }),
    item({ title: 'older', priority: 'low', staleDays: 120, dueStatus: 'none' }),
  ])

  expect(digest.shown.map(i => i.title)).toEqual(['older', 'newer'])
})

it('caps the action list to maxItems but counts all stalled tasks', () => {
  const items = Array.from({ length: 8 }, (_, i) =>
    item({ title: `t${i}`, priority: 'medium', staleDays: 100 - i, dueStatus: 'none' }),
  )
  const digest = build(items)

  expect(digest.flaggedCount).toBe(5)
  expect(digest.totalStalled).toBe(8)
  expect(digest.subject).toBe('Task Review — 5 flagged')
  expect(digest.body).toContain('8 stalled total — here are the 5 that matter most this week.')
})

it('uses a singular summary line when nothing is capped', () => {
  const one = build([item({ title: 'solo' })])
  expect(one.body).toContain('1 stalled task this week.')

  const two = build([item({ title: 'a' }), item({ title: 'b' })])
  expect(two.body).toContain('2 stalled tasks this week.')
})

it('leads with a Start here line built from the top-ranked actionable item', () => {
  const digest = build([
    item({ title: 'top', priority: 'high', suggestedNextAction: 'call the dentist' }),
    item({ title: 'other', priority: 'low' }),
  ])

  expect(digest.body).toContain('Start here →  call the dentist')
  expect(digest.body).toContain('(top · Reminders)')
})

it('skips an actionless top item when choosing the Start here pick', () => {
  const digest = build([
    item({ title: 'no-action', priority: 'high', suggestedNextAction: null, dueStatus: 'past' }),
    item({ title: 'has-action', priority: 'medium', suggestedNextAction: 'mail the form' }),
  ])

  // Ranking still puts no-action first in the list, but Start here picks the first with an action.
  expect(digest.shown[0]?.title).toBe('no-action')
  expect(digest.body).toContain('Start here →  mail the form')
})

it('falls back to title + reasoning for Start here when no shown item has an action', () => {
  const digest = build([
    item({
      title: 'schedule call',
      classification: 'conditional',
      suggestedNextAction: null,
      reasoning: 'needs business hours',
    }),
  ])

  expect(digest.body).toContain('Start here →  schedule call')
  expect(digest.body).toContain('needs business hours')
})

it('renders an item block with a clean title line and priority folded into the Stuck line', () => {
  const digest = build([
    item({
      title: 'fix the gate',
      classification: 'aversion',
      reasoning: 'vague verb hides a project',
      suggestedNextAction: 'buy the hinge',
      priority: 'high',
    }),
  ])

  // Title + list stand on the header line — no trailing priority tag.
  expect(digest.body).toContain('fix the gate · Reminders\n═')
  expect(digest.body).toContain('Stuck:    [high] aversion — vague verb hides a project')
  expect(digest.body).toContain('Do next:  buy the hinge')
})

it('labels each task with its Reminders list so shared-list tasks are obvious', () => {
  const digest = build([item({ title: 'Create will before India trip', list: 'Family' })])

  expect(digest.body).toContain('Create will before India trip · Family')
})

it('renders an HTML body with the title, priority pill color, and Start here callout', () => {
  const digest = build([
    item({ title: 'fix the gate', priority: 'high', suggestedNextAction: 'buy the hinge' }),
  ])

  expect(digest.html).toContain('Start here')
  expect(digest.html).toContain('buy the hinge')
  expect(digest.html).toContain('fix the gate')
  expect(digest.html).toContain('#c5221f') // high-priority pill color
})

it('HTML-escapes user content so titles/reasoning cannot break the markup', () => {
  const digest = build([item({ title: 'a <b> & "c"', reasoning: 'x < y' })])

  expect(digest.html).toContain('a &lt;b&gt; &amp; &quot;c&quot;')
  expect(digest.html).not.toContain('<b>')
})

it('linkifies http(s) URLs in the HTML action', () => {
  const digest = build([
    item({ title: 't', suggestedNextAction: 'open https://irs.gov/W4app now' }),
  ])

  expect(digest.html).toContain('<a href="https://irs.gov/W4app"')
})

it('renders a placeholder Do next line when the action is null', () => {
  const digest = build([
    item({ title: 'call urologist', classification: 'conditional', suggestedNextAction: null }),
  ])

  expect(digest.body).toContain('Do next:  (no single action — fit it into the right context.)')
})

it('omits the habits footer when there are no habits', () => {
  const digest = build([item({ title: 'a task', classification: 'blocked' })])

  expect(digest.body).not.toContain('Not really tasks')
})

it('returns flaggedCount 0 with no candidates when every task is fine', () => {
  const digest = build([
    item({ title: 'x', classification: 'fine' }),
    item({ title: 'y', classification: 'fine' }),
  ])

  expect(digest.flaggedCount).toBe(0)
  expect(digest.totalStalled).toBe(0)
  expect(digest.subject).toBe('Task Review — 0 flagged')
})
