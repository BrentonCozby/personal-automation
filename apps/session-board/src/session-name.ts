/**
 * Session names are kebab-case, and this is where that is decided.
 *
 * The matcher links a session to a progress file by an exact name match against
 * the file's slug, and those slugs are kebab-case because filenames are. A name
 * in any other shape can therefore never match one, so the constraint is what
 * makes automatic linking work rather than a style preference.
 *
 * `web/board.js` carries the same rule so a name is corrected as you type it
 * instead of being refused after the fact. Keep the two in step.
 */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isKebabCase(value: string): boolean {
  return KEBAB_CASE.test(value)
}

/**
 * The nearest kebab-case name to what was typed.
 *
 * Every run of anything else becomes one hyphen, so `Review Perf` and
 * `review  perf!` both land on `review-perf`. An empty result means there was
 * nothing usable in the input, which the caller reads as clearing the name.
 */
export function toKebabCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * What Claude Code adds to a title a session running now already uses.
 *
 * It is how two windows on one conversation are told apart in the tab strip, so
 * it belongs to the window rather than to the work. A name from `claude -n` can
 * never end this way: the board holds those to kebab-case, which has no spaces
 * or parentheses in it.
 */
const WINDOW_NUMBER = / \(\d+\)$/

/** The title as the work is named, with any window number taken off. */
export function withoutWindowNumber(title: string): string {
  return title.replace(WINDOW_NUMBER, '')
}
