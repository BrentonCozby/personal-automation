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
