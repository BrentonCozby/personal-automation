import { expect, it } from 'vitest'
import { lockPathFor } from './locks.js'

// A promotion during the digest's model call would fail on a shared lock, and the failure would
// look like a bug rather than a queue.
it('keeps the one-line edits off the lock the digest holds', () => {
  const digest = lockPathFor('digest')

  expect(lockPathFor('promote')).not.toBe(digest)
  expect(lockPathFor('schedule')).not.toBe(digest)
  expect(lockPathFor('abandon')).not.toBe(digest)
})

it('puts the three edits on one lock, so two of them cannot race', () => {
  expect(lockPathFor('schedule')).toBe(lockPathFor('promote'))
  expect(lockPathFor('abandon')).toBe(lockPathFor('promote'))
})

// Both read the whole vault, and a migration writing under a digest would show it a half-tagged one.
it('keeps the digest and the migration on one lock', () => {
  expect(lockPathFor('migrate')).toBe(lockPathFor('digest'))
})
