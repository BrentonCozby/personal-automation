import { expect, test } from 'vitest'
import { parseArgs } from './cli-args.js'

test('reads the digest command', () => {
  expect(parseArgs(['digest'])).toEqual({ command: 'digest', dryRun: false })
})

test('reads the digest dry-run flag', () => {
  expect(parseArgs(['digest', '--dry-run'])).toEqual({ command: 'digest', dryRun: true })
})

test('reads migrate as a dry run by default', () => {
  expect(parseArgs(['migrate'])).toEqual({ command: 'migrate', isApply: false })
})

// The flag that writes to the vault has to survive parsing on its own, with no other argument
// alongside it to hold its position.
test('reads the apply flag when it is the only argument', () => {
  expect(parseArgs(['migrate', '--apply'])).toEqual({ command: 'migrate', isApply: true })
})

test('reads the apply flag alongside a scope', () => {
  expect(parseArgs(['migrate', '--scope', 'Todos', '--apply'])).toEqual({
    command: 'migrate',
    isApply: true,
    scope: 'Todos',
  })
})

test('reads a scope given before the apply flag', () => {
  expect(parseArgs(['migrate', '--apply', '--scope', 'Todos'])).toEqual({
    command: 'migrate',
    isApply: true,
    scope: 'Todos',
  })
})

test('reads a scope on its own', () => {
  expect(parseArgs(['migrate', '--scope', 'Todos/todos.md'])).toEqual({
    command: 'migrate',
    isApply: false,
    scope: 'Todos/todos.md',
  })
})

test('rejects a scope with no path after it', () => {
  expect(() => parseArgs(['migrate', '--scope'])).toThrow(/--scope/)
})

test('rejects an unknown flag rather than ignoring it', () => {
  expect(() => parseArgs(['migrate', '--force'])).toThrow(/--force/)
})

test('rejects an unknown command', () => {
  expect(() => parseArgs(['sync'])).toThrow(/sync/)
})

test('asks for help when given no command', () => {
  expect(parseArgs([])).toEqual({ command: 'help' })
})

test('asks for help on the help flag', () => {
  expect(parseArgs(['--help'])).toEqual({ command: 'help' })
})
