import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import type { Args } from './cli-args.js'

/**
 * The digest and the migration share one lock: both read the whole vault, and a migration writing
 * while a digest reads would show the digest a half-tagged vault.
 */
const RUN_LOCK = join(tmpdir(), 'tasks.lock')

/**
 * The one-line edits take a lock of their own.
 *
 * The digest holds its lock for the length of a model call, and failing a promotion because a
 * scheduled review happened to be running would be a confusing loss for no safety gain: the digest
 * only reads, and every write here re-reads its line and refuses if it moved. This lock exists only
 * to stop two edits racing each other over the touch clock, where the loser's timestamp would be
 * dropped without a word.
 */
const EDIT_LOCK = join(tmpdir(), 'tasks-edit.lock')

/** Which lock a command has to hold. */
export function lockPathFor(command: Args['command']): string {
  switch (command) {
    case 'promote':
    case 'schedule':
    case 'abandon':
      return EDIT_LOCK
    case 'digest':
    case 'migrate':
    case 'help':
      return RUN_LOCK
    default: {
      const _exhaustive: never = command
      throw new AppError({ message: `Unknown command: ${String(_exhaustive)}` })
    }
  }
}
