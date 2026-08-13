import { expect, test } from 'vitest'
import { readStateTags, stripStateTags, withStateTag } from './tags.js'

test('reads a state tag from the task text', () => {
  expect(readStateTags('heath ceramics second hand #someday ➕ 2025-05-23')).toEqual(['someday'])
})

test('reads no state when the text carries none', () => {
  expect(readStateTags('heath ceramics second hand ➕ 2025-05-23')).toEqual([])
})

test('ignores tags that are not state tags', () => {
  expect(readStateTags('call the plumber #home #errand')).toEqual([])
})

// Vault text is prose, so a state word in a title must not read as a state.
test('ignores a state word that is not a tag', () => {
  expect(readStateTags('keep the sourdough starter active')).toEqual([])
})

// Obsidian treats #someday and #someday-maybe as different tags, so a prefix match would
// misread a nested or hyphenated tag as a state.
test('ignores a longer tag that starts with a state name', () => {
  expect(readStateTags('sort the garage #someday-maybe')).toEqual([])
})

// The states are mutually exclusive, so two on one line is a contradiction. Reporting both is what
// lets the reader refuse rather than pick one by the order they happen to be typed in.
test('reads every state tag on the line, in order', () => {
  expect(readStateTags('condition leather shoes #someday #active ➕ 2025-06-07')).toEqual([
    'someday',
    'active',
  ])
})

test('strips the state tag out of the text', () => {
  expect(stripStateTags('heath ceramics second hand #someday ➕ 2025-05-23')).toBe(
    'heath ceramics second hand ➕ 2025-05-23',
  )
})

test('leaves unrelated tags in place when stripping', () => {
  expect(stripStateTags('call the plumber #home #active')).toBe('call the plumber #home')
})

test('inserts the tag before the first Tasks-plugin marker', () => {
  const line = '- [ ] heath ceramics second hand ➕ 2025-05-23'

  expect(withStateTag({ line, state: 'someday' })).toBe(
    '- [ ] heath ceramics second hand #someday ➕ 2025-05-23',
  )
})

test('appends the tag when the line carries no markers', () => {
  const line = '- [ ] call the plumber'

  expect(withStateTag({ line, state: 'active' })).toBe('- [ ] call the plumber #active')
})

test('replaces an existing state tag rather than adding a second', () => {
  const line = '- [ ] heath ceramics second hand #someday ➕ 2025-05-23'

  expect(withStateTag({ line, state: 'active' })).toBe(
    '- [ ] heath ceramics second hand #active ➕ 2025-05-23',
  )
})

test('preserves indentation and the checkbox status character', () => {
  const line = '  - [x] order toddler formula ✅ 2026-06-09'

  expect(withStateTag({ line, state: 'done' })).toBe(
    '  - [x] order toddler formula #done ✅ 2026-06-09',
  )
})
