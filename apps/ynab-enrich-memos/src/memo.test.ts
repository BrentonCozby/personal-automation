import { describe, expect, it } from 'vitest'
import { buildMemo } from './memo.js'

describe('buildMemo', (): void => {
  it('prepends the prefix and a space', (): void => {
    expect(buildMemo('USB-C cable ($9.99). Total $9.99')).toBe(
      'auto-gen: USB-C cable ($9.99). Total $9.99',
    )
  })

  it('collapses newlines and runs of whitespace to single spaces', (): void => {
    expect(buildMemo('line one\n  line two\t x')).toBe('auto-gen: line one line two x')
  })

  it('strips wrapping quotes the model sometimes adds', (): void => {
    expect(buildMemo('"quoted summary"')).toBe('auto-gen: quoted summary')
  })

  it('swaps an em dash for a comma, so none reaches YNAB', (): void => {
    expect(buildMemo('1 Essentials item — Total $39.86')).toBe(
      'auto-gen: 1 Essentials item, Total $39.86',
    )
  })

  it('leaves no stray comma when the em dash sits at an edge', (): void => {
    expect(buildMemo('— Total $39.86')).toBe('auto-gen: Total $39.86')
    expect(buildMemo('USB-C cable —')).toBe('auto-gen: USB-C cable')
  })

  it('keeps an en dash, which is valid in a number range', (): void => {
    expect(buildMemo('AA batteries, 5–10 pack. Total $4.50')).toBe(
      'auto-gen: AA batteries, 5–10 pack. Total $4.50',
    )
  })

  it('clamps to the YNAB max length (prefix included)', (): void => {
    const memo = buildMemo('x'.repeat(600))
    expect(memo.length).toBe(500)
    expect(memo.startsWith('auto-gen: ')).toBe(true)
  })
})
