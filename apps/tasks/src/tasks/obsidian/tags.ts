import { TASK_STATES, type TaskState } from '../../state/types.js'
import { FIRST_MARKER } from './markers.js'

// A state tag has to start at a tag boundary and end at one. Without the lookbehind, `foo#active`
// would read as a state; without the lookahead, Obsidian's nested and hyphenated tags
// (`#someday-maybe`, `#someday/travel`) would each read as a bare `#someday`.
const STATE_TAG_SOURCE = `(?<=^|\\s)#(${TASK_STATES.join('|')})(?![\\w/-])`
const STATE_TAGS = new RegExp(STATE_TAG_SOURCE, 'gu')
// Removal takes the whitespace in front of the tag with it, so pulling a tag out of the middle of
// a line doesn't leave a double space behind.
const STATE_TAG_TO_REMOVE = new RegExp(`\\s*${STATE_TAG_SOURCE}`, 'gu')

/**
 * Every state tag on a task's text, in the order they appear.
 *
 * All of them rather than the first, because the states are mutually exclusive: a line carrying two
 * is a contradiction, and picking one by position would resolve it silently and differently
 * depending on which the author happened to type first.
 */
export function readStateTags(text: string): TaskState[] {
  const found: TaskState[] = []
  for (const match of text.matchAll(STATE_TAGS)) {
    // find() rather than a cast: it narrows to TaskState by matching against the real list.
    const state = TASK_STATES.find(candidate => candidate === match[1])
    if (state) found.push(state)
  }

  return found
}

/** The text with every state tag removed. Other tags are left alone. */
export function stripStateTags(text: string): string {
  return clearStateTags(text).trim()
}

/**
 * The line with every state tag removed and nothing else touched. Unlike `stripStateTags`, this
 * keeps the ends as they are, so it is safe on a whole line whose leading whitespace is its
 * indentation.
 */
export function clearStateTags(line: string): string {
  return line.replace(STATE_TAG_TO_REMOVE, '')
}

/**
 * The task line with its state set, replacing any state tag already on it.
 *
 * The tag lands at the end of the description and before the first Tasks-plugin signifier. Placing
 * it after the signifiers would let a trailing marker's value absorb it.
 */
export function withStateTag({ line, state }: { line: string; state: TaskState }): string {
  const cleared = clearStateTags(line)
  const tag = `#${state}`
  const markerIndex = cleared.search(FIRST_MARKER)
  if (markerIndex === -1) return `${cleared.trimEnd()} ${tag}`

  return `${cleared.slice(0, markerIndex).trimEnd()} ${tag} ${cleared.slice(markerIndex)}`
}
