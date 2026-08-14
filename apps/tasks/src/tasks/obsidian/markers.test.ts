import { describe, expect, it } from 'vitest'
import { withDroppedMarker } from './markers.js'

describe('withDroppedMarker', () => {
  it('rewrites the done marker as a cancelled one, keeping the date', () => {
    expect(withDroppedMarker('- [-] refill soaps ✅ 2026-08-13')).toBe(
      '- [-] refill soaps ❌ 2026-08-13',
    )
  })

  it('leaves the recurrence rule and the due date alone', () => {
    expect(
      withDroppedMarker('- [-] Do a lesson in Pimsleur 🔁 every week 📅 2026-08-11 ✅ 2026-08-13'),
    ).toBe('- [-] Do a lesson in Pimsleur 🔁 every week 📅 2026-08-11 ❌ 2026-08-13')
  })

  it('drops the done marker when the line already carries a cancelled one', () => {
    expect(withDroppedMarker('- [-] sell the couch ✅ 2026-08-13 ❌ 2026-08-12')).toBe(
      '- [-] sell the couch ❌ 2026-08-12',
    )
  })

  it('returns a line carrying only a cancelled marker unchanged', () => {
    const line = '- [-] sell the couch ❌ 2026-08-12'
    expect(withDroppedMarker(line)).toBe(line)
  })

  it('returns a line carrying no closing date unchanged', () => {
    const line = '- [-] sell the couch'
    expect(withDroppedMarker(line)).toBe(line)
  })
})
