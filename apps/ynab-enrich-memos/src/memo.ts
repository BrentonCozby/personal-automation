import { MAX_MEMO_LENGTH, MEMO_PREFIX } from './constants.js'

/**
 * Turns the model's one-line item summary into the memo to PATCH: collapse whitespace, drop
 * wrapping quotes, swap any em dash for a comma, prepend the `auto-gen:` marker, and clamp to
 * YNAB's length limit.
 */
export function buildMemo(summary: string): string {
  const cleaned = summary
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    // The prompt tells the model not to use an em dash, but an instruction is not a guarantee
    // and the result is written to YNAB. A comma is the one swap that still reads correctly
    // wherever the dash sat, so it needs no guess about the job the dash was doing.
    .replace(/ ?— ?/g, ', ')
    .replace(/^,\s*|,\s*$/g, '')

  return `${MEMO_PREFIX} ${cleaned}`.slice(0, MAX_MEMO_LENGTH)
}
