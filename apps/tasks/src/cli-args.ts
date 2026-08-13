import { AppError } from '@personal-automation/common/errors'
import { isTaskDateShape } from './state/days.js'

export type Args =
  | { command: 'help' }
  | { command: 'digest'; dryRun: boolean }
  | { command: 'alert'; dryRun: boolean }
  | { command: 'migrate'; isApply: boolean; scope?: string }
  | { command: 'promote'; query: string; isOverCap: boolean }
  | { command: 'abandon'; query: string }
  | { command: 'schedule'; query: string; date: string }

/**
 * Turns argv into a command. Kept out of index.ts so it can be tested without running main().
 *
 * An unrecognised flag throws rather than being ignored, because the flags here decide whether the
 * vault gets written to. A dropped `--apply` reads as a dry run, which looks like success.
 */
export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') return { command: 'help' }

  switch (command) {
    case 'digest':
      assertKnownFlags({ rest, known: ['--dry-run'] })

      return { command: 'digest', dryRun: rest.includes('--dry-run') }
    case 'alert':
      assertKnownFlags({ rest, known: ['--dry-run'] })

      return { command: 'alert', dryRun: rest.includes('--dry-run') }
    case 'migrate':
      return parseMigrate(rest)
    case 'promote':
      return parsePromote(rest)
    case 'abandon':
      return { command: 'abandon', query: titleFrom({ words: assertNoFlags(rest), of: 'abandon' }) }
    case 'schedule':
      return parseSchedule(rest)
    default:
      throw new AppError({ message: `Unknown command: ${command}. Try --help.` })
  }
}

function parseMigrate(rest: string[]): Args {
  const scopeIndex = rest.indexOf('--scope')
  if (scopeIndex !== -1 && rest[scopeIndex + 1] === undefined) {
    throw new AppError({ message: '--scope needs a path relative to the vault root.' })
  }

  const scope = scopeIndex === -1 ? undefined : rest[scopeIndex + 1]
  // Drop the flag and its value together. Guarding on scopeIndex matters: at -1 the value index
  // would be 0, which silently swallows whatever argument came first.
  const flags =
    scopeIndex === -1 ? rest : rest.filter((_, i) => i !== scopeIndex && i !== scopeIndex + 1)
  assertKnownFlags({ rest: flags, known: ['--apply'] })

  return {
    command: 'migrate',
    isApply: flags.includes('--apply'),
    ...(scope !== undefined ? { scope } : {}),
  }
}

function parsePromote(rest: string[]): Args {
  const flags = rest.filter(isFlag)
  assertKnownFlags({ rest: flags, known: ['--over-cap'] })

  return {
    command: 'promote',
    query: titleFrom({ words: rest.filter(arg => !isFlag(arg)), of: 'promote' }),
    isOverCap: flags.includes('--over-cap'),
  }
}

// The date is the last argument, so everything before it stays available for the title. A date
// that doesn't parse is rejected here rather than read as another word of the title, which would
// turn a typo into a "no task matches" that names the wrong problem.
function parseSchedule(rest: string[]): Args {
  const words = assertNoFlags(rest)
  const date = words[words.length - 1]
  if (!date || !isTaskDateShape(date)) {
    throw new AppError({
      message: 'schedule needs a date last: tasks schedule <title> <YYYY-MM-DD | +Nd>',
    })
  }

  return {
    command: 'schedule',
    query: titleFrom({ words: words.slice(0, -1), of: 'schedule' }),
    date,
  }
}

// Every non-flag argument joins into the search text, so a title needs no quoting: `promote fix
// the bike` and `promote "fix the bike"` mean the same thing.
function titleFrom({ words, of }: { words: string[]; of: string }): string {
  const query = words.join(' ').trim()
  if (!query) {
    throw new AppError({ message: `${of} needs part of a task title: tasks ${of} <title>` })
  }

  return query
}

function assertNoFlags(rest: string[]): string[] {
  assertKnownFlags({ rest: rest.filter(isFlag), known: [] })

  return rest
}

function isFlag(arg: string): boolean {
  return arg.startsWith('--')
}

function assertKnownFlags({ rest, known }: { rest: string[]; known: string[] }): void {
  for (const arg of rest) {
    if (!known.includes(arg)) throw new AppError({ message: `Unknown argument: ${arg}` })
  }
}
