import { describe, expect, it } from 'vitest'
import { buildReceiptQuery } from './query.js'

describe('buildReceiptQuery', (): void => {
  it('ORs the senders and brackets a ± day window (before is exclusive, so +1 day)', (): void => {
    const q = buildReceiptQuery({
      fromAddresses: ['auto-confirm@amazon.com', 'shipment-tracking@amazon.com'],
      txnDate: '2026-05-20',
      windowDays: 5,
    })

    expect(q).toBe(
      '(from:auto-confirm@amazon.com OR from:shipment-tracking@amazon.com) after:2026/05/15 before:2026/05/26',
    )
  })

  it('handles a single sender and a window that crosses a month boundary', (): void => {
    const q = buildReceiptQuery({
      fromAddresses: ['x@amazon.com'],
      txnDate: '2026-03-01',
      windowDays: 3,
    })

    expect(q).toBe('(from:x@amazon.com) after:2026/02/26 before:2026/03/05')
  })
})
