import { expect, test } from 'vitest'
import type { VaultMigrationPlan } from './migrate.js'
import { renderMigrationReport } from './migrate-report.js'

const plan: VaultMigrationPlan = {
  scannedFiles: 1,
  counts: { someday: 19 },
  skipped: { recurring: 10, 'already finished': 56, 'already tagged': 2 },
  changes: [
    {
      path: 'Todos/todos.md',
      line: 9,
      before: '- [ ] heath ceramics second hand ➕ 2025-05-23',
      after: '- [ ] heath ceramics second hand #someday ➕ 2025-05-23',
      state: 'someday',
    },
    {
      path: 'Todos/todos.md',
      line: 3,
      before: '- [ ] condition leather shoes ➕ 2025-06-07',
      after: '- [ ] condition leather shoes #someday ➕ 2025-06-07',
      state: 'someday',
    },
  ],
}

test('renders the dry-run report', () => {
  expect(renderMigrationReport({ plan, isApplied: false })).toMatchSnapshot()
})

test('renders the applied report', () => {
  expect(renderMigrationReport({ plan, isApplied: true })).toMatchSnapshot()
})

test('renders a plan that would change nothing', () => {
  const empty: VaultMigrationPlan = {
    scannedFiles: 43,
    counts: {},
    skipped: { 'already tagged': 559 },
    changes: [],
  }

  expect(renderMigrationReport({ plan: empty, isApplied: false })).toMatchSnapshot()
})

// The tone rules are requirements, not decoration, so they get an assertion rather than only a
// reviewer's memory.
test('avoids the words the digest is not allowed to use', () => {
  const report = renderMigrationReport({ plan, isApplied: false }).toLowerCase()

  for (const word of ['overdue', 'failing', 'behind', 'should have']) {
    expect(report).not.toContain(word)
  }
})

test('never reports untagged tasks as a problem to fix', () => {
  const report = renderMigrationReport({ plan, isApplied: false }).toLowerCase()

  for (const word of ['error', 'invalid', 'missing', 'unsorted', 'cleanup']) {
    expect(report).not.toContain(word)
  }
})
