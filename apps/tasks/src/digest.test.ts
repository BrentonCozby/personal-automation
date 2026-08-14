import { expect, it } from 'vitest'
import { buildDigest, type Digest, type DigestItem, type DoneSummary } from './digest.js'
import type { CapSuggestion } from './state/cap-suggestion.js'
import type { DoneEntry } from './state/done.js'

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

function done(overrides: Partial<DoneSummary> = {}): DoneSummary {
  const summary = {
    windowDays: 7,
    finished: [],
    dropped: [],
    movedCount: 0,
    ...overrides,
  }

  // The counts follow the entries unless a test sets them, since that is how closedSince builds them.
  return {
    finishedCount: summary.finished.reduce((total, task) => total + task.times, 0),
    droppedCount: summary.dropped.reduce((total, task) => total + task.times, 0),
    ...summary,
  }
}

function entry(title: string, day: number, times = 1): DoneEntry {
  return { title, list: 'todos', closed: new Date(2026, 7, day), times }
}

function build(items: DigestItem[], activeCount = items.length, doneList = done()): Digest {
  return buildDigest({ items, activeCount, done: doneList })
}

it('counts the quiet tasks in the subject', () => {
  expect(build([item()]).subject).toBe('Task Review: 1 task has gone quiet')
  expect(build([item({ title: 'a' }), item({ title: 'b' })]).subject).toBe(
    'Task Review: 2 tasks have gone quiet',
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

// The order is by momentum, which is a proxy rather than a measure of progress, so it has to be
// named. With one task there is no order to explain.
it('names the order when there is more than one task, and not when there is one', () => {
  const two = build([item({ title: 'a' }), item({ title: 'b' })])
  const one = build([item()])

  expect(two.body).toContain('Nearest done first, going by what you touched last.')
  expect(two.html).toContain('Nearest done first')
  expect(one.body).not.toContain('Nearest done first')
  expect(one.html).not.toContain('Nearest done first')
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
  expect(digest.body).toContain('Quiet:    12 days · blocked: waiting on the hinge to arrive')
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

  expect(digest.body).toContain('Do next:  (no single step; fit it into the right context.)')
})

it('offers the two ways out as things to do in Obsidian', () => {
  const digest = build([item({ title: 'book india flights' })])

  expect(digest.body).toContain('Give it a date: open it in Obsidian and set a 📅 date')
  expect(digest.body).toContain('Drop it: set its status to Dropped')
})

// This email is read on a phone. A pasteable shell command would name an action the reader cannot
// take from what they are holding.
it('names no command to run', () => {
  const digest = build([item({ title: 'book india flights' })])

  expect(digest.body).not.toContain('pnpm')
  expect(digest.html).not.toContain('pnpm')
})

// The whole point of the model is to remove the deficit feeling, so the app's own words never
// accuse. The model is told the same in its prompt.
it('never uses the accusatory register in its own text', () => {
  const digest = buildDigest({
    items: [
      item({ title: 'a', passedDueDate: '2026-08-10', suggestedNextAction: null }),
      item({ title: 'b', reasoning: 'waiting on a reply' }),
    ],
    activeCount: 3,
    done: done({ finished: [entry('pay the water bill', 18)] }),
    // Included here rather than tested apart: the cap note is the one place the review comments on
    // a pattern in your choices, so it is the likeliest place for the register to slip.
    capSuggestion: { overrideCount: 4, windowDays: 30, suggestedCap: 6 },
  })

  for (const word of ['overdue', 'failing', 'behind', 'should have', 'stalled', 'flagged']) {
    expect(digest.body.toLowerCase()).not.toContain(word)
    expect(digest.html.toLowerCase()).not.toContain(word)
  }
})

it('renders an HTML body with the Start here callout, the quiet count, and the ways out', () => {
  const digest = build([item({ title: 'fix the gate', suggestedNextAction: 'buy the hinge' })])

  expect(digest.html).toContain('Start here')
  expect(digest.html).toContain('buy the hinge')
  expect(digest.html).toContain('fix the gate')
  expect(digest.html).toContain('quiet 9 days')
  expect(digest.html).toContain('set its status to Dropped')
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

// The done list is the half of the review that reads without anything being wrong, so it rides along
// with the quiet tasks rather than replacing them.
it('adds the done list under the quiet tasks', () => {
  const digest = build(
    [item()],
    3,
    done({ finished: [entry('pay the water bill', 18)], movedCount: 2 }),
  )

  expect(digest.body).toContain('The last 7 days')
  expect(digest.body).toContain('Finished: 1')
  expect(digest.body).toContain('✓ 2026-08-18  pay the water bill')
  expect(digest.body).toContain('Moved:    2 of the 3 you are carrying')
  expect(digest.html).toContain('pay the water bill')
})

// Dropping a task on purpose is the mechanism the cap runs on, so it is reported as a result rather
// than as something missing.
it('reports what was dropped as a decision, not a gap', () => {
  const digest = build([item()], 1, done({ dropped: [entry('replace the garage remote', 17)] }))

  expect(digest.body).toContain('Dropped:  1  (chosen, not missed)')
  expect(digest.body).toContain('✗ 2026-08-17  replace the garage remote')
})

// A chore done three times is one line with a count, and still three things finished.
it('marks a repeated task once, with how many times', () => {
  const digest = build([item()], 1, done({ finished: [entry('cook beans', 18, 3)] }))

  expect(digest.body).toContain('✓ 2026-08-18  cook beans  (×3)')
  expect(digest.body).toContain('Finished: 3')
  expect(digest.html).toContain('(×3)')
})

it('leaves out a line for a count of zero', () => {
  const digest = build([item()], 1, done({ finished: [entry('pay the water bill', 18)] }))

  expect(digest.body).toContain('Finished: 1')
  expect(digest.body).not.toContain('Dropped:')
  expect(digest.body).not.toContain('Moved:')
})

it('omits the done list entirely when the window holds nothing', () => {
  const digest = build([item()], 1, done())

  expect(digest.body).not.toContain('The last 7 days')
  expect(digest.html).not.toContain('The last 7 days')
})

// With nothing quiet there is no ask, so the email is only the record of what happened.
it('renders a done-list-only email when nothing has gone quiet', () => {
  const digest = build([], 3, done({ finished: [entry('pay the water bill', 18)], movedCount: 3 }))

  expect(digest.subject).toBe('Task Review: 1 finished')
  expect(digest.body).toContain('Nothing has gone quiet.')
  expect(digest.body).toContain('✓ 2026-08-18  pay the water bill')
  expect(digest.body).not.toContain('Start here')
  expect(digest.body).not.toContain('gone quiet.\n')
})

it('counts both halves in the subject of a done-list-only email', () => {
  const finished = [entry('a', 18), entry('b', 17)]
  const dropped = [entry('c', 16)]

  expect(build([], 1, done({ finished, dropped })).subject).toBe(
    'Task Review: 2 finished, 1 dropped',
  )
  expect(build([], 1, done({ dropped })).subject).toBe('Task Review: 1 dropped')
})

function withCap(suggestion: Partial<CapSuggestion> = {}): Digest {
  return buildDigest({
    items: [item()],
    activeCount: 1,
    done: done(),
    capSuggestion: { overrideCount: 4, windowDays: 30, suggestedCap: 6, ...suggestion },
  })
}

it('says nothing about the cap when the cap is holding', () => {
  expect(build([item()]).body).not.toContain('The cap')
  expect(build([item()]).html).not.toContain('TASKS_WIP_CAP')
})

// The number carried and the number suggested are the same on purpose: the edit renames what is
// already true rather than granting anything new.
it('names how often the cap was raised and the most that was carried', () => {
  expect(withCap().body).toContain('You raised it 4 times in the last 30 days, carrying 6 at once.')
  expect(withCap().body).toContain('A limit you go around that often is set too low.')
  expect(withCap().body).toContain('TASKS_WIP_CAP=6  in apps/tasks/.env')
})

it('reads a single raise as once', () => {
  expect(withCap({ overrideCount: 1 }).body).toContain('You raised it once in the last 30 days')
})

it('renders the cap note in the HTML body too', () => {
  expect(withCap().html).toContain('The cap')
  expect(withCap().html).toContain('TASKS_WIP_CAP=6')
})

// Last in the email: it is a note about the system, not about any of the work above it.
it('puts the cap note after the done list', () => {
  const digest = buildDigest({
    items: [],
    activeCount: 1,
    done: done({ finished: [entry('pay the water bill', 18)] }),
    capSuggestion: { overrideCount: 4, windowDays: 30, suggestedCap: 6 },
  })

  expect(digest.body.indexOf('The cap')).toBeGreaterThan(digest.body.indexOf('pay the water bill'))
})
