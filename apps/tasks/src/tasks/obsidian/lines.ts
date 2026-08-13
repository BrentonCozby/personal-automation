import type { TaskState, TaskStatus } from '../../state/types.js'
import { readStateTags } from './tags.js'

// Optional indentation (a nested subtask is still a task), a `-`/`*`/`+` bullet, then a checkbox
// holding exactly one character. The character itself is captured rather than matched, so an
// unrecognised status is reported instead of making the line invisible.
const TASK_LINE = /^(\s*)[-*+]\s+\[(.)\]\s*(.*)$/u

const RECURRENCE = /🔁/u

// The Tasks plugin's four configured statuses. In Progress counts as open because the task is
// still live; anything else is a status this app has no rule for.
const STATUS_BY_CHAR: Record<string, TaskStatus> = {
  ' ': 'open',
  '/': 'open',
  x: 'done',
  X: 'done',
  '-': 'cancelled',
}

export type TaskLine = {
  status: TaskStatus
  isRecurring: boolean
  /**
   * Every state tag on the line. More than one is a contradiction the reader refuses to resolve,
   * because the states are mutually exclusive and nothing on the line says which was meant.
   */
  states: readonly TaskState[]
  /** The one state the task is in, or undefined when it carries none or more than one. */
  state: TaskState | undefined
  /** Everything after the checkbox, with markers and tags left in place. */
  text: string
  /** Leading whitespace, kept so a rewrite can preserve nesting. */
  indent: string
}

/**
 * Reads one Markdown line as a task, or undefined when it isn't one.
 *
 * Every checkbox status is read, not just open ones, because the migration has to translate
 * completed and cancelled tasks too. Callers that only want live tasks filter on `status`.
 */
export function parseTaskLine(line: string): TaskLine | undefined {
  const match = line.match(TASK_LINE)
  if (!match) return undefined

  const text = (match[3] || '').trim()
  if (!text) return undefined

  const states = readStateTags(text)

  return {
    status: STATUS_BY_CHAR[match[2] || ''] || 'other',
    isRecurring: RECURRENCE.test(text),
    states,
    state: states.length === 1 ? states[0] : undefined,
    text,
    indent: match[1] || '',
  }
}
