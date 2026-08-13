import { basename } from 'node:path'
import type { TaskState, TaskStatus } from '../../state/types.js'
import { parseTaskLine } from './lines.js'
import { stripStateTags } from './tags.js'

// Obsidian Tasks "created" / "due" / "done" / "cancelled" markers. The date that follows each is a
// bare YYYY-MM-DD.
const CREATED_DATE = /➕\s*(\d{4}-\d{2}-\d{2})/u
const DUE_DATE = /📅\s*(\d{4}-\d{2}-\d{2})/u
const DONE_DATE = /✅\s*(\d{4}-\d{2}-\d{2})/u
const CANCELLED_DATE = /❌\s*(\d{4}-\d{2}-\d{2})/u
// A recurrence rule (`🔁 every week on Sunday`) runs from the marker to the next Tasks emoji or
// the line end. Stripped from the title; the task is still judged by its due date like any other.
const RECURRENCE_RULE = /🔁[^➕📅⏳🛫✅❌🔺⏫🔼🔽⏬🆔⛔🏁]*/u

// Any checkbox line. Used to stop notes collection: a more-indented checkbox is a separate
// (sub)task, not a parent's note.
const ANY_CHECKBOX_LINE = /^\s*[-*+]\s+\[.\]/u
// Strips a line's leading indentation and an optional list-bullet marker, leaving the note text.
const NOTE_BULLET_PREFIX = /^\s*(?:[-*+]\s+)?/

// Every Obsidian Tasks metadata marker that can trail the text, stripped so the title reads clean.
// Date markers carry a YYYY-MM-DD; id/dependsOn/onCompletion carry one token; the priority markers
// stand alone. Only created/due/recurrence are acted on above; the rest are removed from the
// title but otherwise ignored.
const DATE_METADATA = /[➕📅⏳🛫✅❌]\s*\d{4}-\d{2}-\d{2}/gu
const TOKEN_METADATA = /[🆔⛔🏁]\s*\S+/gu
const PRIORITY_METADATA = /[🔺⏫🔼🔽⏬]/gu

/**
 * One task line found in a vault file, with everything any caller needs: where it sits, what it
 * says, and the text a rewrite has to match. Every reader of the vault goes through this shape, so
 * the digest, the migration, and a promotion can't disagree about what a task is.
 */
export type ScannedTask = {
  /** Vault-relative path of the file holding it. */
  path: string
  /** The file name without `.md`, which is what the digest shows as the list. */
  list: string
  /** One-based, so it lines up with what an editor shows. */
  lineNumber: number
  /** The line verbatim. A rewrite matches on this before replacing it. */
  lineText: string
  /**
   * The line and its indented notes together: the text the touch clock hashes. Any edit to either
   * one changes it, which is what makes an edit count as a touch.
   */
  raw: string
  status: TaskStatus
  isRecurring: boolean
  /** Every state tag on the line. More than one is a contradiction, and `state` is then undefined. */
  states: readonly TaskState[]
  /** The one state the task is in, or undefined when it carries none or more than one. */
  state: TaskState | undefined
  /**
   * The title with state tags and Tasks-plugin markers stripped. This plus `list` is the task's
   * identity, which is what lets a task keep it across a state change. Empty when the line holds
   * nothing but markers.
   */
  title: string
  /** Lines indented under the task that aren't themselves checkboxes, or null when there are none. */
  notes: string | null
  created: Date | null
  due: Date | null
  /**
   * The day the box was closed: the `✅` date on a finished task or the `❌` date on a dropped one.
   * Null on every open task, and on a closed one carrying no date. The only thing the vault records
   * about finishing or dropping, so the done list is read from it.
   */
  closed: Date | null
}

/**
 * Pure: reads one Markdown file's task lines, whatever their checkbox status. Callers that only
 * want live tasks filter on `status`; callers that only want real todos filter out an empty title.
 *
 * `created`/`due` come from the `➕`/`📅` markers and are parsed as LOCAL dates. A bare YYYY-MM-DD
 * through `new Date(str)` would be UTC midnight, which is the previous day in any negative-offset
 * zone and would skew every day count that reads them.
 */
export function scanFileTasks({ path, content }: { path: string; content: string }): ScannedTask[] {
  const tasks: ScannedTask[] = []
  const list = basename(path, '.md')
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? ''
    const parsed = parseTaskLine(lineText)
    if (!parsed) continue

    const notes = collectNotes({ lines, taskIndex: i, taskIndent: parsed.indent.length })
    tasks.push({
      path,
      list,
      lineNumber: i + 1,
      lineText,
      raw: rawOf({ lineText, notes }),
      status: parsed.status,
      isRecurring: parsed.isRecurring,
      states: parsed.states,
      state: parsed.state,
      title: cleanTitle(parsed.text),
      notes,
      created: parseLocalDate(parsed.text.match(CREATED_DATE)?.[1]),
      due: parseLocalDate(parsed.text.match(DUE_DATE)?.[1]),
      // The checkbox says which of the two a task is, so the date only has to say when. A line
      // carrying both is only reachable by hand, and finishing is the more meaningful of the two.
      closed: parseLocalDate(
        parsed.text.match(DONE_DATE)?.[1] ?? parsed.text.match(CANCELLED_DATE)?.[1],
      ),
    })
  }

  return tasks
}

/**
 * The text the touch clock hashes for a task. Exported so a caller that has just rewritten a line
 * can build the new value the same way this scan does: building it differently would leave a
 * fingerprint that the next scan disagrees with, and every run would read as a fresh touch.
 */
export function rawOf({ lineText, notes }: { lineText: string; notes: string | null }): string {
  return notes === null ? lineText : `${lineText}\n${notes}`
}

function indentOf(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0
}

// Collects the lines immediately under a task as its notes, with the bullet/indent stripped. A
// note line is more indented than the task, not blank, and not a checkbox, since a deeper
// checkbox is a separate subtask.
function collectNotes({
  lines,
  taskIndex,
  taskIndent,
}: {
  lines: string[]
  taskIndex: number
  taskIndent: number
}): string | null {
  const noteLines: string[] = []
  for (let j = taskIndex + 1; j < lines.length; j++) {
    const next = lines[j] ?? ''
    if (next.trim() === '') break
    if (indentOf(next) <= taskIndent) break
    if (ANY_CHECKBOX_LINE.test(next)) break
    noteLines.push(next.replace(NOTE_BULLET_PREFIX, '').trimEnd())
  }

  return noteLines.length > 0 ? noteLines.join('\n') : null
}

// State tags come out; every other tag stays, because an ordinary tag is part of what the task
// says and a state tag is only this app's bookkeeping.
function cleanTitle(text: string): string {
  return stripStateTags(text)
    .replace(RECURRENCE_RULE, '')
    .replace(DATE_METADATA, '')
    .replace(TOKEN_METADATA, '')
    .replace(PRIORITY_METADATA, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseLocalDate(value: string | undefined): Date | null {
  if (!value) return null
  const parts = value.split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])

  return new Date(year, month - 1, day)
}
