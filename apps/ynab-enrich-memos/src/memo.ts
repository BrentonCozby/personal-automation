import { MAX_MEMO_LENGTH, MEMO_PREFIX } from './constants.js'

/**
 * Turns the model's one-line item summary into the memo to PATCH: collapse whitespace, drop
 * wrapping quotes, prepend the `auto-gen:` marker, and clamp to YNAB's length limit.
 */
export function buildMemo(summary: string): string {
  const cleaned = summary
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()

  return `${MEMO_PREFIX} ${cleaned}`.slice(0, MAX_MEMO_LENGTH)
}
