import { AppError } from '@personal-automation/common/errors'

export type Args =
  | { command: 'help' }
  | { command: 'digest'; dryRun: boolean }
  | { command: 'migrate'; isApply: boolean; scope?: string }

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
    case 'migrate':
      return parseMigrate(rest)
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

function assertKnownFlags({ rest, known }: { rest: string[]; known: string[] }): void {
  for (const arg of rest) {
    if (!known.includes(arg)) throw new AppError({ message: `Unknown argument: ${arg}` })
  }
}
