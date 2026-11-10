import type { SessionMetadata } from './types.js'

/**
 * Whether a row still counts: neither dismissed (off the board on purpose) nor
 * superseded (an empty pointer to the session that took its work over).
 */
export function isOnBoard(entry: SessionMetadata): boolean {
  return !entry.isDismissed && !entry.supersededBy
}
