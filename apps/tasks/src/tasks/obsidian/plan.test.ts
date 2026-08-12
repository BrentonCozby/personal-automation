import { expect, test } from 'vitest'
import { planFileMigration } from './plan.js'

const path = 'Todos/todos.md'

test('plans a someday tag for an open one-off task', () => {
  const plan = planFileMigration({ path, content: '- [ ] sort the garage ➕ 2025-05-23' })

  expect(plan.changes).toEqual([
    {
      path,
      line: 1,
      before: '- [ ] sort the garage ➕ 2025-05-23',
      after: '- [ ] sort the garage #someday ➕ 2025-05-23',
      state: 'someday',
    },
  ])
})

test('plans no change for a checked task', () => {
  const plan = planFileMigration({ path, content: '- [x] order formula ✅ 2026-06-09' })

  expect(plan.changes).toEqual([])
  expect(plan.skipped['already finished']).toBe(1)
})

test('reports one-based line numbers', () => {
  const content = ['# Todos', '', '- [ ] sort the garage'].join('\n')
  const plan = planFileMigration({ path, content })

  expect(plan.changes[0]?.line).toBe(3)
})

test('plans no change for an open recurring task', () => {
  const plan = planFileMigration({ path, content: '- [ ] water the tree 🔁 every 2 weeks' })

  expect(plan.changes).toEqual([])
  expect(plan.skipped.recurring).toBe(1)
})

test('plans no change for a task that already carries a state', () => {
  const plan = planFileMigration({ path, content: '- [ ] sort the garage #someday' })

  expect(plan.changes).toEqual([])
  expect(plan.skipped['already tagged']).toBe(1)
})

test('ignores lines that are not tasks', () => {
  const content = ['# Todos', 'Some prose.', '  - 📝 [[a-note]]'].join('\n')
  const plan = planFileMigration({ path, content })

  expect(plan.changes).toEqual([])
  expect(plan.counts).toEqual({})
})

test('counts planned changes by target state', () => {
  const content = [
    '- [ ] sort the garage',
    '- [ ] call the plumber',
    '- [x] order formula',
    '- [-] renew the gym',
  ].join('\n')
  const plan = planFileMigration({ path, content })

  expect(plan.counts).toEqual({ someday: 2 })
  expect(plan.skipped['already finished']).toBe(2)
})

// Running the pass twice must not double-tag or churn the file.
test('plans nothing on content it has already migrated', () => {
  const content = ['- [ ] sort the garage', '- [x] order formula'].join('\n')
  const first = planFileMigration({ path, content })
  const migrated = applyPlan({ content, plan: first })

  expect(planFileMigration({ path, content: migrated }).changes).toEqual([])
})

function applyPlan({
  content,
  plan,
}: {
  content: string
  plan: ReturnType<typeof planFileMigration>
}): string {
  const lines = content.split('\n')
  for (const change of plan.changes) lines[change.line - 1] = change.after

  return lines.join('\n')
}
