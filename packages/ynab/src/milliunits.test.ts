import { describe, expect, it } from 'vitest'
import { formatDollars, milliunitsToDollars } from './milliunits.js'

describe('milliunitsToDollars', (): void => {
  it('converts positive milliunits', (): void => {
    expect(milliunitsToDollars(15_000)).toBe(15)
  })

  it('converts negative milliunits', (): void => {
    expect(milliunitsToDollars(-15_000)).toBe(-15)
  })

  it('handles zero', (): void => {
    expect(milliunitsToDollars(0)).toBe(0)
  })

  it('preserves fractional cents', (): void => {
    expect(milliunitsToDollars(12_345)).toBe(12.345)
  })
})

describe('formatDollars', (): void => {
  it('formats positive amount', (): void => {
    expect(formatDollars(15_000)).toBe('$15.00')
  })

  it('formats negative amount with leading minus', (): void => {
    expect(formatDollars(-15_000)).toBe('-$15.00')
  })

  it('rounds to 2 decimal places', (): void => {
    expect(formatDollars(12_345)).toBe('$12.35')
  })

  it('formats zero', (): void => {
    expect(formatDollars(0)).toBe('$0.00')
  })
})
