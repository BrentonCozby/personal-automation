import { expect, test } from 'vitest'
import { migrationTargetFor } from './migration.js'

test('an open task moves to someday', () => {
  const target = migrationTargetFor({ status: 'open', isRecurring: false, state: undefined })

  expect(target).toEqual({ kind: 'set', state: 'someday' })
})

// The checkbox already records that a task is finished, and the done list reads the ✅ date rather
// than a tag, so a #done tag would repeat what the line says and nothing would read it.
test('a completed task is left alone', () => {
  const target = migrationTargetFor({ status: 'done', isRecurring: false, state: undefined })

  expect(target).toEqual({ kind: 'leave', reason: 'already finished' })
})

test('a cancelled task is left alone', () => {
  const target = migrationTargetFor({ status: 'cancelled', isRecurring: false, state: undefined })

  expect(target).toEqual({ kind: 'leave', reason: 'already finished' })
})

// A live recurring chore is a real commitment the Tasks plugin already manages by due date, and
// none of the four stored states describes it. Untagged is a valid permanent condition, so it stays.
test('an open recurring task is left untagged', () => {
  const target = migrationTargetFor({ status: 'open', isRecurring: true, state: undefined })

  expect(target).toEqual({ kind: 'leave', reason: 'recurring' })
})

// The one thing the pass does. Everything else it sees, it leaves.
test('only open one-off tasks are tagged', () => {
  const statuses = ['open', 'done', 'cancelled', 'other'] as const
  const set = statuses
    .flatMap(status =>
      [true, false].map(isRecurring => ({
        status,
        isRecurring,
        target: migrationTargetFor({ status, isRecurring, state: undefined }),
      })),
    )
    .filter(row => row.target.kind === 'set')

  expect(set).toEqual([
    { status: 'open', isRecurring: false, target: { kind: 'set', state: 'someday' } },
  ])
})

// Idempotence: a second run has to be a no-op, so nothing already carrying a state is rewritten.
test('a task that already carries a state is left alone', () => {
  const target = migrationTargetFor({ status: 'open', isRecurring: false, state: 'active' })

  expect(target).toEqual({ kind: 'leave', reason: 'already tagged' })
})

// Promotion is the user's decision. No signal in the vault is allowed to manufacture a commitment.
test('never promotes anything to active', () => {
  const statuses = ['open', 'done', 'cancelled'] as const
  const targets = statuses.flatMap(status =>
    [true, false].map(isRecurring => migrationTargetFor({ status, isRecurring, state: undefined })),
  )

  expect(targets.some(t => t.kind === 'set' && t.state === 'active')).toBe(false)
})
