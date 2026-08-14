import { expect, it } from 'vitest'
import { type ScannedTask, scanFileTasks } from './scan.js'

function scan(content: string): ScannedTask[] {
  return scanFileTasks({ content, path: 'todos.md' })
}

it('reads an open task and maps the created/due markers', () => {
  const tasks = scan('- [ ] book india flights ➕ 2025-05-20 📅 2026-06-24')

  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.title).toBe('book india flights')
  expect(tasks[0]?.list).toBe('todos')
  expect(tasks[0]?.path).toBe('todos.md')
  expect(tasks[0]?.status).toBe('open')
  expect(tasks[0]?.created?.getDate()).toBe(20)
  expect(tasks[0]?.due?.getDate()).toBe(24)
})

// The done list needs to know when a box was closed, which is the only thing the vault records about
// finishing or dropping a task.
it('reads the date a task was finished or dropped', () => {
  const [finished] = scan('- [x] pay the water bill ✅ 2026-08-11')
  const [dropped] = scan('- [-] replace the garage remote ❌ 2026-08-10')

  expect(finished?.closed?.getDate()).toBe(11)
  expect(finished?.closed?.getMonth()).toBe(7)
  expect(dropped?.closed?.getDate()).toBe(10)
})

// A date JS would roll forward instead of reject, which would alert on a day the vault never named.
it('leaves the due date null when the numbers name no real day', () => {
  const [february] = scan('- [ ] renew passport 📅 2026-02-30')
  const [month] = scan('- [ ] renew passport 📅 2026-13-01')

  expect(february?.due).toBeNull()
  expect(month?.due).toBeNull()
})

it('leaves the closed date null on an open task', () => {
  const [task] = scan('- [ ] book india flights ➕ 2025-05-20')

  expect(task?.closed).toBeNull()
})

// Only reachable by hand. The checkbox says which list the task belongs in, so the date just says
// when, and finishing something is the more meaningful of the two.
it('prefers the finished date when a line carries both', () => {
  const [task] = scan('- [x] odd one ❌ 2026-08-01 ✅ 2026-08-09')

  expect(task?.closed?.getDate()).toBe(9)
})

it('parses dates as LOCAL midnight, not UTC (no off-by-one on any day count)', () => {
  const [task] = scan('- [ ] file taxes ➕ 2026-01-01')

  // new Date('2026-01-01') would be UTC midnight, the previous day in any negative-offset zone.
  expect(task?.created?.getFullYear()).toBe(2026)
  expect(task?.created?.getMonth()).toBe(0)
  expect(task?.created?.getDate()).toBe(1)
  expect(task?.created?.getHours()).toBe(0)
})

// Every status is read, not just open ones: the migration has to translate finished tasks and the
// done list counts them. Callers that only want live tasks filter on `status`.
it('reads every checkbox status, not just open ones', () => {
  const tasks = scan(
    [
      '- [ ] open task',
      '- [x] done task',
      '- [X] done upper',
      '- [-] cancelled task',
      '- [/] in progress task',
      '- [>] forwarded task',
    ].join('\n'),
  )

  expect(tasks.map(task => task.status)).toEqual([
    'open',
    'done',
    'done',
    'cancelled',
    // In progress is open: the task is still live and still counts against the cap.
    'open',
    'other',
  ])
})

it('records the state tag and leaves the title free of it', () => {
  const [task] = scan('- [ ] heath ceramics second hand #someday ➕ 2025-05-23')

  expect(task?.state).toBe('someday')
  expect(task?.title).toBe('heath ceramics second hand')
})

it('reports no state for an untagged task', () => {
  const [task] = scan('- [ ] file taxes #finance')

  expect(task?.state).toBeUndefined()
  expect(task?.title).toBe('file taxes #finance')
})

it('flags a recurring task and strips the rule from the title', () => {
  const tasks = scan(
    ['- [ ] book flights', '- [ ] water the plants 🔁 every week ➕ 2026-06-01'].join('\n'),
  )

  expect(tasks.map(task => task.isRecurring)).toEqual([false, true])
  expect(tasks.map(task => task.title)).toEqual(['book flights', 'water the plants'])
})

it('strips a recurrence rule sitting between the title and the dates', () => {
  const [task] = scan('- [ ] call mom 🔁 every week on Sunday ➕ 2026-06-04 📅 2026-06-14')

  expect(task?.title).toBe('call mom')
  expect(task?.created?.getDate()).toBe(4)
  expect(task?.due?.getDate()).toBe(14)
})

it('supports -, *, and + bullet markers and leading indentation (subtasks)', () => {
  const tasks = scan(['- [ ] dash', '* [ ] star', '+ [ ] plus', '  - [ ] indented'].join('\n'))

  expect(tasks.map(task => task.title)).toEqual(['dash', 'star', 'plus', 'indented'])
})

it('leaves created/due null when their markers are absent', () => {
  const [task] = scan('- [ ] just a plain todo')

  expect(task?.created).toBeNull()
  expect(task?.due).toBeNull()
})

it('strips Tasks metadata from the title but keeps #tags', () => {
  const [task] = scan('- [ ] file taxes 🔼 ➕ 2026-01-01 📅 2026-02-15 🛫 2026-01-05 #finance')

  expect(task?.title).toBe('file taxes #finance')
})

it('strips id / dependsOn / onCompletion markers from the title', () => {
  const [task] = scan('- [ ] ship release 🆔 abc123 ⛔ def456 🏁 delete')

  expect(task?.title).toBe('ship release')
})

it('numbers lines from one, counting the lines that are not tasks', () => {
  const tasks = scan(['# Todos', '', '- [ ] first', 'some prose', '- [ ] second'].join('\n'))

  expect(tasks.map(task => task.lineNumber)).toEqual([3, 5])
})

it('keeps the line verbatim, so a rewrite can match on it', () => {
  const [task] = scan('  - [ ] indented task  ')

  expect(task?.lineText).toBe('  - [ ] indented task  ')
})

it('ignores headers, prose, and blank lines', () => {
  const tasks = scan(['# Heading', '', 'a paragraph of notes', '> a quote', '---'].join('\n'))

  expect(tasks).toEqual([])
})

it('returns an empty array for empty content', () => {
  expect(scan('')).toEqual([])
})

it('handles CRLF line endings', () => {
  const tasks = scan('- [ ] one\r\n- [ ] two')

  expect(tasks.map(task => task.title)).toEqual(['one', 'two'])
})

it('captures an indented sub-bullet as the task notes', () => {
  const [task] = scan(
    ['- [ ] secure furniture ➕ 2025-12-08', '    - anchors are in the cabinet'].join('\n'),
  )

  expect(task?.notes).toBe('anchors are in the cabinet')
})

it('captures multi-line notes, stripping bullets and indentation', () => {
  const [task] = scan(['- [ ] plan trip', '  - book hotel', '  confirm dates'].join('\n'))

  expect(task?.notes).toBe('book hotel\nconfirm dates')
})

it('treats an indented checkbox as its own task, not the parent notes', () => {
  const tasks = scan(['- [ ] parent', '    - [ ] child'].join('\n'))

  expect(tasks.map(task => task.title)).toEqual(['parent', 'child'])
  expect(tasks[0]?.notes).toBeNull()
})

it('does not pull a following sibling task into notes', () => {
  const [first] = scan(['- [ ] a', '- [ ] b'].join('\n'))

  expect(first?.notes).toBeNull()
})

// The touch clock hashes `raw`, so an edit to either the line or its notes has to change it.
it('joins the line and its notes into the raw text the touch clock hashes', () => {
  const [task] = scan(['- [ ] plan trip', '  - book hotel'].join('\n'))

  expect(task?.raw).toBe('- [ ] plan trip\nbook hotel')
})

it('uses the line alone as raw when the task has no notes', () => {
  const [task] = scan('- [ ] plan trip')

  expect(task?.raw).toBe('- [ ] plan trip')
})

// A line holding nothing but markers has no title to identify it by. It is still returned, because
// the migration tags lines rather than titles; readers that need a title filter on it.
it('returns an empty title for a line that is only metadata', () => {
  const [task] = scan('- [ ] 📅 2026-02-15')

  expect(task?.title).toBe('')
})

// Two states on one line is a contradiction, so the scanner reports both and commits to neither.
// Picking the first would make the meaning depend on which the author happened to type first.
it('reports both tags and no single state when a line carries two', () => {
  const [task] = scan('- [ ] condition leather shoes #someday #active ➕ 2025-06-07')

  expect(task?.states).toEqual(['someday', 'active'])
  expect(task?.state).toBeUndefined()
  expect(task?.title).toBe('condition leather shoes')
})

it('reports one state as both the list and the single state', () => {
  const [task] = scan('- [ ] fix the bike #active')

  expect(task?.states).toEqual(['active'])
  expect(task?.state).toBe('active')
})
