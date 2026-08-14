import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readTouchClock } from '../state/touch-clock.js'
import { withTaskClock } from './task-io.js'

const NOW = new Date(2026, 7, 20, 8, 0)
const TODOS_FILE = 'Todos/todos.md'
const SCOPES = [TODOS_FILE]

let vaultPath: string
let runsDir: string
let clockPath: string

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), 'tasks-vault-'))
  runsDir = mkdtempSync(join(tmpdir(), 'tasks-runs-'))
  clockPath = join(runsDir, 'touch-clock.json')
  mkdirSync(join(vaultPath, 'Todos'))
})

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true })
  rmSync(runsDir, { recursive: true, force: true })
})

function writeTodos(lines: string[]): void {
  writeFileSync(join(vaultPath, TODOS_FILE), `# Todos\n\n${lines.join('\n')}\n`)
}

function readTodos(): string {
  return readFileSync(join(vaultPath, TODOS_FILE), 'utf8')
}

async function readOnce(): Promise<void> {
  await withTaskClock<null>({
    vaultPath,
    scopes: SCOPES,
    clockPath,
    now: NOW,
    act: async ({ clock }) => ({ result: null, clock }),
  })
}

it('corrects the done marker the plugin stamps on a dropped task', async () => {
  writeTodos([
    '- [-] Do a lesson in Pimsleur 🔁 every week 📅 2026-08-11 ✅ 2026-08-20',
    '- [x] cook beans/lentils ✅ 2026-08-19',
    '- [ ] sell the couch #active',
  ])

  await readOnce()

  const todos = readTodos()
  expect(todos).toContain('- [-] Do a lesson in Pimsleur 🔁 every week 📅 2026-08-11 ❌ 2026-08-20')
  // A finished task keeps its own marker: only the checkbox decides which one belongs.
  expect(todos).toContain('- [x] cook beans/lentils ✅ 2026-08-19')
  expect(todos).toContain('- [ ] sell the couch #active')
})

it('leaves the touch clock alone, since a dropped task holds no entry in it', async () => {
  writeTodos(['- [-] refill soaps ✅ 2026-08-20', '- [ ] sell the couch #active'])

  await readOnce()
  const clock = await readTouchClock(clockPath)

  expect(Object.keys(clock.tasks)).toEqual(['["todos","sell the couch"]'])
})

it('is a no-op on a second read, so a run never rewrites what it already corrected', async () => {
  writeTodos(['- [-] refill soaps ✅ 2026-08-20'])

  await readOnce()
  const afterFirst = readTodos()
  await readOnce()

  expect(readTodos()).toBe(afterFirst)
})
