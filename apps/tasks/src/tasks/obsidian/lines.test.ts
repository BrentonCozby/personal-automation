import { expect, test } from 'vitest'
import { parseTaskLine } from './lines.js'

test('reads an unchecked box as an open task', () => {
  expect(parseTaskLine('- [ ] call the plumber')?.status).toBe('open')
})

test('reads a checked box as done', () => {
  expect(parseTaskLine('- [x] order toddler formula ✅ 2026-06-09')?.status).toBe('done')
})

test('reads a dashed box as cancelled', () => {
  expect(parseTaskLine('- [-] renew the gym membership')?.status).toBe('cancelled')
})

// The Tasks plugin's In Progress status is a live task, so it counts as open rather than as a
// status this app has no rule for.
test('reads an in-progress box as open', () => {
  expect(parseTaskLine('- [/] draft the will')?.status).toBe('open')
})

test('reads an unrecognised status character as other', () => {
  expect(parseTaskLine('- [?] something odd')?.status).toBe('other')
})

test('reads no task from a line without a checkbox', () => {
  expect(parseTaskLine('  - 📝 [[heath-ceramics-secondhand]]')).toBeUndefined()
})

test('reads no task from a checkbox with an empty description', () => {
  expect(parseTaskLine('- [ ]   ')).toBeUndefined()
})

test('detects a recurrence rule', () => {
  const parsed = parseTaskLine('- [ ] water schefflera tree 🔁 every 2 weeks 📅 2026-08-13')

  expect(parsed?.isRecurring).toBe(true)
})

test('reports no recurrence on a one-off task', () => {
  expect(parseTaskLine('- [ ] call the plumber 📅 2026-08-13')?.isRecurring).toBe(false)
})

test('reads the state tag off the line', () => {
  expect(parseTaskLine('- [ ] sort the garage #someday ➕ 2025-05-23')?.state).toBe('someday')
})

test('reports no state when the line carries no state tag', () => {
  expect(parseTaskLine('- [ ] sort the garage ➕ 2025-05-23')?.state).toBeUndefined()
})

test('reads a task nested under another task', () => {
  const parsed = parseTaskLine('    - [ ] book the rental van')

  expect(parsed?.status).toBe('open')
})

test('accepts asterisk and plus bullets', () => {
  expect(parseTaskLine('* [ ] one')?.status).toBe('open')
  expect(parseTaskLine('+ [ ] two')?.status).toBe('open')
})

test('keeps the description text with its markers intact', () => {
  const parsed = parseTaskLine('- [ ] sort the garage #someday ➕ 2025-05-23')

  expect(parsed?.text).toBe('sort the garage #someday ➕ 2025-05-23')
})
