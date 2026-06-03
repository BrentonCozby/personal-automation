import { describe, expect, it } from 'vitest'
import { buildMemo } from './memo.js'

describe('buildMemo', (): void => {
  it('prepends the prefix and a space', (): void => {
    expect(buildMemo('USB-C cable ($9.99) — Total $9.99')).toBe(
      'auto-gen: USB-C cable ($9.99) — Total $9.99',
    )
  })

  it('collapses newlines and runs of whitespace to single spaces', (): void => {
    expect(buildMemo('line one\n  line two\t x')).toBe('auto-gen: line one line two x')
  })

  it('strips wrapping quotes the model sometimes adds', (): void => {
    expect(buildMemo('"quoted summary"')).toBe('auto-gen: quoted summary')
  })

  it('clamps to the YNAB max length (prefix included)', (): void => {
    const memo = buildMemo('x'.repeat(600))
    expect(memo.length).toBe(500)
    expect(memo.startsWith('auto-gen: ')).toBe(true)
  })
})
