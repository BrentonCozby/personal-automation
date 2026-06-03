import { describe, expect, it } from 'vitest'
import { isAuthentic } from './trust.js'

describe('isAuthentic', (): void => {
  it('keeps a message whose DMARC passed', (): void => {
    expect(
      isAuthentic(
        'mx.google.com; spf=pass smtp.mailfrom=amazon.com; dkim=pass header.d=amazon.com; dmarc=pass header.from=amazon.com',
      ),
    ).toBe(true)
  })

  it('drops a message whose DMARC explicitly failed (forged sender)', (): void => {
    expect(
      isAuthentic('mx.google.com; spf=fail; dkim=fail; dmarc=fail header.from=amazon.com'),
    ).toBe(false)
  })

  it('is case-insensitive', (): void => {
    expect(isAuthentic('DMARC=FAIL header.from=amazon.com')).toBe(false)
  })

  it('fails open when the header is absent or empty (Gmail stamps real mail; absence = unknown)', (): void => {
    expect(isAuthentic(null)).toBe(true)
    expect(isAuthentic('')).toBe(true)
  })
})
