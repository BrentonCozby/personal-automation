import { describe, expect, it } from 'vitest'
import { asCancelled, withDueDate } from './edits.js'

describe('withDueDate', () => {
  it('appends a due date to a line that has none', () => {
    expect(withDueDate({ line: '- [ ] fix the bike', date: '2026-08-20' })).toBe(
      '- [ ] fix the bike 📅 2026-08-20',
    )
  })

  it('replaces a due date already on the line, in place', () => {
    expect(
      withDueDate({ line: '- [ ] fix the bike 📅 2026-08-20 ➕ 2026-05-01', date: '2026-09-01' }),
    ).toBe('- [ ] fix the bike 📅 2026-09-01 ➕ 2026-05-01')
  })

  it('leaves the state tag and the other markers alone', () => {
    expect(
      withDueDate({ line: '  - [ ] fix the bike #active ➕ 2026-05-01', date: '2026-08-20' }),
    ).toBe('  - [ ] fix the bike #active ➕ 2026-05-01 📅 2026-08-20')
  })

  it('does not leave a double space when the line ends in whitespace', () => {
    expect(withDueDate({ line: '- [ ] fix the bike  ', date: '2026-08-20' })).toBe(
      '- [ ] fix the bike 📅 2026-08-20',
    )
  })
})

describe('asCancelled', () => {
  it('cancels the checkbox and stamps the date', () => {
    expect(asCancelled({ line: '- [ ] fix the bike', date: '2026-08-12' })).toBe(
      '- [-] fix the bike ❌ 2026-08-12',
    )
  })

  // The checkbox is the record. A tag beside it would say the same thing twice.
  it('takes the state tag off', () => {
    expect(
      asCancelled({ line: '- [ ] fix the bike #active ➕ 2026-05-01', date: '2026-08-12' }),
    ).toBe('- [-] fix the bike ➕ 2026-05-01 ❌ 2026-08-12')
  })

  it('keeps indentation, the bullet character, and every other marker', () => {
    expect(
      asCancelled({ line: '    * [ ] fix the bike 🔼 📅 2026-08-20', date: '2026-08-12' }),
    ).toBe('    * [-] fix the bike 🔼 📅 2026-08-20 ❌ 2026-08-12')
  })

  it('cancels an in-progress task too', () => {
    expect(asCancelled({ line: '- [/] fix the bike', date: '2026-08-12' })).toBe(
      '- [-] fix the bike ❌ 2026-08-12',
    )
  })
})
