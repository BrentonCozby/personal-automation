import { TASK_STATES, type TaskState } from '../../state/types.js'
import { FIRST_MARKER } from './markers.js'

// A state tag has to start at a tag boundary and end at one. Without the lookbehind, `foo#active`
// would read as a state; without the lookahead, Obsidian's nested and hyphenated tags
// (`#someday-maybe`, `#someday/travel`) would each read as a bare `#someday`.
const STATE_TAG_SOURCE = `(?<=^|\\s)#(${TASK_STATES.join('|')})(?![\\w/-])`
const STATE_TAG = new RegExp(STATE_TAG_SOURCE, 'u')
// Removal takes the whitespace in front of the tag with it, so pulling a tag out of the middle of
// a line doesn't leave a double space behind.
const STATE_TAG_TO_REMOVE = new RegExp(`\\s*${STATE_TAG_SOURCE}`, 'gu')

/** The state stored on a task's text, or undefined when it carries no state tag. */
export function readStateTag(text: string): TaskState | undefined {
  const found = text.match(STATE_TAG)?.[1]

  // find() rather than a cast: it narrows to TaskState by matching against the real list.
  return TASK_STATES.find(state => state === found)
}

/** The text with every state tag removed. Other tags are left alone. */
export function stripStateTags(text: string): string {
  return text.replace(STATE_TAG_TO_REMOVE, '').trim()
}

/**
 * The task line with its state set, replacing any state tag already on it.
 *
 * The tag lands at the end of the description and before the first Tasks-plugin signifier. Placing
 * it after the signifiers would let a trailing marker's value absorb it.
 */
export function withStateTag({ line, state }: { line: string; state: TaskState }): string {
  const cleared = line.replace(STATE_TAG_TO_REMOVE, '')
  const tag = `#${state}`
  const markerIndex = cleared.search(FIRST_MARKER)
  if (markerIndex === -1) return `${cleared.trimEnd()} ${tag}`

  return `${cleared.slice(0, markerIndex).trimEnd()} ${tag} ${cleared.slice(markerIndex)}`
}
