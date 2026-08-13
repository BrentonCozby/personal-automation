import { expect, it } from 'vitest'
import { buildDigest, type Digest, type DigestItem } from './digest.js'

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    title: 'book india flights',
    list: 'todos',
    classification: 'aversion',
    reasoning: 'vague verb hides a multi-step project',
    suggestedNextAction: 'Text Heidi for date windows',
    untouchedDays: 9,
    passedDueDate: null,
    ...overrides,
  }
}

function build(items: DigestItem[], activeCount = items.length): Digest {
  return buildDigest({ items, activeCount })
}

it('counts the quiet tasks in the subject', () => {
  expect(build([item()]).subject).toBe('Task Review — 1 task has gone quiet')
  expect(build([item({ title: 'a' }), item({ title: 'b' })]).subject).toBe(
    'Task Review — 2 tasks have gone quiet',
  )
})

it('says how many of the tasks being carried have gone quiet', () => {
  const digest = build([item({ title: 'a' }), item({ title: 'b' })], 3)

  expect(digest.body).toContain('2 of the 3 tasks you are carrying have gone quiet.')
})

it('says so plainly when every task being carried has gone quiet', () => {
  const digest = build([item({ title: 'a' }), item({ title: 'b' })], 2)

  expect(digest.body).toContain('Both of the tasks you are carrying have gone quiet.')
})

it('reads naturally when one task is being carried and it has gone quiet', () => {
  const digest = build([item()], 1)

  expect(digest.body).toContain('The one task you are carrying has gone quiet.')
})

it('leads with a Start here line built from the first item that has an action', () => {
  const digest = build([
    item({ title: 'no-action', suggestedNextAction: null }),
    item({ title: 'has-action', suggestedNextAction: 'mail the form' }),
  ])

  expect(digest.body).toContain('Start here →  mail the form')
  expect(digest.body).toContain('(has-action · todos)')
})

it('falls back to the title and the reason when no item has an action', () => {
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

it('renders how long the task has been quiet, its reason, and its next step', () => {
  const digest = build([
    item({
      title: 'fix the gate',
      list: 'Family',
      classification: 'blocked',
      reasoning: 'waiting on the hinge to arrive',
      suggestedNextAction: 'Check the delivery date',
      untouchedDays: 12,
    }),
  ])

  expect(digest.body).toContain('fix the gate · Family\n═')
  expect(digest.body).toContain('Quiet:    12 days · blocked — waiting on the hinge to arrive')
  expect(digest.body).toContain('Do next:  Check the delivery date')
})

it('says one day rather than 1 days', () => {
  const digest = build([item({ untouchedDays: 1 })])

  expect(digest.body).toContain('Quiet:    1 day · ')
})

it('notes a date that has gone by, and says nothing when there is none', () => {
  const withDate = build([item({ passedDueDate: '2026-08-10' })])
  const withoutDate = build([item()])

  expect(withDate.body).toContain('Its date, 2026-08-10, has gone by.')
  expect(withoutDate.body).not.toContain('has gone by')
})

it('prints a placeholder when the model found no single next step', () => {
  const digest = build([item({ classification: 'conditional', suggestedNextAction: null })])

  expect(digest.body).toContain('Do next:  (no single step — fit it into the right context.)')
})

it('prints the schedule and abandon commands for each task', () => {
  const digest = build([item({ title: 'book india flights' })])

  expect(digest.body).toContain(
    'pnpm --filter @personal-automation/tasks tasks schedule book india flights +7d',
  )
  expect(digest.body).toContain(
    'pnpm --filter @personal-automation/tasks tasks abandon book india flights',
  )
})

// The CLI joins its remaining arguments, so a plain title needs no quotes. One carrying a character
// the shell acts on does, or the pasted command would not run.
it('quotes a title the shell would otherwise act on', () => {
  const digest = build([item({ title: 'sort out T&C (again)' })])

  expect(digest.body).toContain("tasks schedule 'sort out T&C (again)' +7d")
  expect(digest.body).toContain("tasks abandon 'sort out T&C (again)'")
})

it('closes and reopens the quoting around an embedded quote', () => {
  const digest = build([item({ title: "fix Heidi's laptop" })])

  expect(digest.body).toContain("tasks abandon 'fix Heidi'\\''s laptop'")
})

// The whole point of the model is to remove the deficit feeling, so the app's own words never
// accuse. The model is told the same in its prompt.
it('never uses the accusatory register in its own text', () => {
  const digest = build(
    [
      item({ title: 'a', passedDueDate: '2026-08-10', suggestedNextAction: null }),
      item({ title: 'b', reasoning: 'waiting on a reply' }),
    ],
    3,
  )

  for (const word of ['overdue', 'failing', 'behind', 'should have', 'stalled', 'flagged']) {
    expect(digest.body.toLowerCase()).not.toContain(word)
    expect(digest.html.toLowerCase()).not.toContain(word)
  }
})

it('renders an HTML body with the Start here callout, the quiet count, and the commands', () => {
  const digest = build([item({ title: 'fix the gate', suggestedNextAction: 'buy the hinge' })])

  expect(digest.html).toContain('Start here')
  expect(digest.html).toContain('buy the hinge')
  expect(digest.html).toContain('fix the gate')
  expect(digest.html).toContain('quiet 9 days')
  expect(digest.html).toContain('tasks abandon fix the gate')
})

it('HTML-escapes user content so titles and reasoning cannot break the markup', () => {
  const digest = build([item({ title: 'a <b> & "c"', reasoning: 'x < y' })])

  expect(digest.html).toContain('a &lt;b&gt; &amp; &quot;c&quot;')
  expect(digest.html).not.toContain('<b>')
})

it('linkifies http(s) URLs in the HTML action', () => {
  const digest = build([item({ suggestedNextAction: 'open https://irs.gov/W4app now' })])

  expect(digest.html).toContain('<a href="https://irs.gov/W4app"')
})
