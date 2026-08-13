import { expect, it, test } from 'vitest'
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

test('joins the words of a promote query, so a title needs no quoting', () => {
  expect(parseArgs(['promote', 'fix', 'the', 'bike'])).toEqual({
    command: 'promote',
    query: 'fix the bike',
    isOverCap: false,
  })
})

test('reads a quoted promote query as one argument', () => {
  expect(parseArgs(['promote', 'fix the bike'])).toEqual({
    command: 'promote',
    query: 'fix the bike',
    isOverCap: false,
  })
})

test('reads the over-cap flag from either side of the query', () => {
  const expected = { command: 'promote', query: 'fix the bike', isOverCap: true }

  expect(parseArgs(['promote', 'fix the bike', '--over-cap'])).toEqual(expected)
  expect(parseArgs(['promote', '--over-cap', 'fix the bike'])).toEqual(expected)
})

test('rejects a promote with no query', () => {
  expect(() => parseArgs(['promote'])).toThrow(/needs part of a task title/)
  expect(() => parseArgs(['promote', '--over-cap'])).toThrow(/needs part of a task title/)
})

test('rejects an unknown promote flag rather than reading it as the query', () => {
  expect(() => parseArgs(['promote', 'bike', '--force'])).toThrow(/--force/)
})

test('reads an abandon query', () => {
  expect(parseArgs(['abandon', 'fix', 'the', 'bike'])).toEqual({
    command: 'abandon',
    query: 'fix the bike',
  })
})

test('rejects a flag on abandon, which takes none', () => {
  expect(() => parseArgs(['abandon', 'bike', '--force'])).toThrow(/--force/)
})

test('reads the date off the end of a schedule command', () => {
  expect(parseArgs(['schedule', 'fix', 'the', 'bike', '2026-08-20'])).toEqual({
    command: 'schedule',
    query: 'fix the bike',
    date: '2026-08-20',
  })
})

test('reads a relative schedule date', () => {
  expect(parseArgs(['schedule', 'bike', '+7d'])).toEqual({
    command: 'schedule',
    query: 'bike',
    date: '+7d',
  })
})

// Without this, a mistyped date reads as another word of the title and the error names the wrong
// problem: "no task matches" rather than "that is not a date".
test('rejects a schedule whose last argument is not a date', () => {
  expect(() => parseArgs(['schedule', 'fix the bike', 'tuesday'])).toThrow(/needs a date last/)
  expect(() => parseArgs(['schedule', 'fix the bike'])).toThrow(/needs a date last/)
})

test('rejects a schedule with a date but no title', () => {
  expect(() => parseArgs(['schedule', '2026-08-20'])).toThrow(/needs part of a task title/)
})

it('parses alert', () => {
  expect(parseArgs(['alert'])).toEqual({ command: 'alert', dryRun: false })
  expect(parseArgs(['alert', '--dry-run'])).toEqual({ command: 'alert', dryRun: true })
})

it('rejects an unknown flag on alert', () => {
  expect(() => parseArgs(['alert', '--force'])).toThrow(/Unknown argument: --force/)
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
