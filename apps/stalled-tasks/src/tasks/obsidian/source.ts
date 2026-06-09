import type { Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { AppError } from '@personal-automation/common/errors'
import type { Task, TaskSource } from '../types.js'

// With no configured lists, the source reads only this inbox file at the vault root. Reading the
// whole vault would sweep in incidental `- [ ]` checkboxes from notes/templates that aren't todos.
const DEFAULT_TODOS_FILE = 'todos.md'

// Obsidian Tasks "created" / "due" markers. The date that follows each is a bare YYYY-MM-DD.
const CREATED_DATE = /➕\s*(\d{4}-\d{2}-\d{2})/u
const DUE_DATE = /📅\s*(\d{4}-\d{2}-\d{2})/u
// A recurrence rule (`🔁 every week on Sunday`) runs from the marker to the next Tasks emoji or
// the line end. Stripped from the title; the task is kept and judged by its due date like any
// other dated task (a recurring task is just one whose due date rolls forward).
const RECURRENCE_RULE = /🔁[^➕📅⏳🛫✅❌🔺⏫🔼🔽⏬🆔⛔🏁]*/u

// An open task line: optional indentation (nested subtasks count), a `-`/`*`/`+` bullet, then a
// checkbox with a single space inside. Only `[ ]` is open — a done `[x]`, cancelled `[-]`,
// in-progress `[/]`, or any other status character won't match, so they're left out of the digest.
const OPEN_TASK_LINE = /^\s*[-*+]\s+\[ \]\s+(.*)$/u

// Any checkbox line (open or not). Used to stop notes collection: a more-indented checkbox is a
// separate (sub)task, not a parent's note.
const ANY_CHECKBOX_LINE = /^\s*[-*+]\s+\[.\]/u
// Strips a line's leading indentation and an optional list-bullet marker, leaving the note text.
const NOTE_BULLET_PREFIX = /^\s*(?:[-*+]\s+)?/

// Every Obsidian Tasks metadata marker that can trail the text, stripped so the digest shows a
// clean title. Date markers carry a YYYY-MM-DD; id/dependsOn/onCompletion carry one token; the
// priority markers stand alone. We only act on created/due/recurrence above — the rest are removed
// from the title but otherwise ignored.
const DATE_METADATA = /[➕📅⏳🛫✅❌]\s*\d{4}-\d{2}-\d{2}/gu
const TOKEN_METADATA = /[🆔⛔🏁]\s*\S+/gu
const PRIORITY_METADATA = /[🔺⏫🔼🔽⏬]/gu

/**
 * Reads open todos from an Obsidian vault on disk. Reads `todos.md` at the vault root by default,
 * or the files/folders named in `lists` (paths relative to the vault root; a folder is walked for
 * its `*.md` files). The vault is read-only — this never writes or pulls, so it sees whatever the
 * last sync left on disk; keep the vault synced separately (Obsidian Sync or Obsidian Git).
 */
export function createObsidianTaskSource({
  vaultPath,
  lists,
}: {
  vaultPath: string
  lists: readonly string[]
}): TaskSource {
  async function list(): Promise<Task[]> {
    const files = await resolveTodoFiles({ vaultPath, lists })
    const perFile = await Promise.all(
      files.map(async file => {
        const content = await readFile(file.absPath, 'utf8')

        return parseTodoMarkdown({ content, relativePath: file.relativePath, list: file.list })
      }),
    )

    return perFile.flat()
  }

  return { list }
}

type TodoFile = { absPath: string; relativePath: string; list: string }

async function resolveTodoFiles({
  vaultPath,
  lists,
}: {
  vaultPath: string
  lists: readonly string[]
}): Promise<TodoFile[]> {
  await assertDirectory(vaultPath)
  const entries = lists.length === 0 ? [DEFAULT_TODOS_FILE] : lists
  const files: TodoFile[] = []
  for (const entry of entries) {
    const absPath = join(vaultPath, entry)
    const info = await statOrThrow({ path: absPath, entry })
    if (!info.isDirectory()) {
      files.push(toTodoFile({ vaultPath, absPath }))
      continue
    }
    const found = await readdir(absPath, { recursive: true })
    for (const rel of found) {
      if (rel.endsWith('.md')) files.push(toTodoFile({ vaultPath, absPath: join(absPath, rel) }))
    }
  }

  return files
}

function toTodoFile({ vaultPath, absPath }: { vaultPath: string; absPath: string }): TodoFile {
  return {
    absPath,
    relativePath: relative(vaultPath, absPath),
    list: basename(absPath, '.md'),
  }
}

async function assertDirectory(vaultPath: string): Promise<void> {
  let info: Stats
  try {
    info = await stat(vaultPath)
  } catch (err) {
    throw new AppError({
      message: `Obsidian vault not found at OBSIDIAN_VAULT_PATH: ${vaultPath}. Point it at your vault's folder.`,
      cause: err,
    })
  }
  if (!info.isDirectory()) {
    throw new AppError({ message: `OBSIDIAN_VAULT_PATH is not a directory: ${vaultPath}` })
  }
}

async function statOrThrow({ path, entry }: { path: string; entry: string }): Promise<Stats> {
  try {
    return await stat(path)
  } catch (err) {
    throw new AppError({
      message: `Configured task path "${entry}" not found in the vault (looked at ${path}). Check TASK_LISTS.`,
      cause: err,
    })
  }
}

/**
 * Pure: maps one Markdown file's open-task lines to Task[]. Keeps every open `[ ]` checkbox —
 * including recurring ones (the `🔁` rule is stripped from the title, and the task is judged by
 * its due date like any other) — and skips anything that isn't an open checkbox. Unit-testable
 * like the Apple source's `parseBridgeOutput`. `created`/`due` come from the `➕`/`📅` markers,
 * parsed as LOCAL dates —
 * a bare YYYY-MM-DD via `new Date(str)` would be UTC midnight, i.e. the previous day in any
 * negative-offset zone, which would skew the staleness clock that `created` drives. Lines indented
 * under a task (that aren't themselves checkboxes) become its `notes`.
 */
export function parseTodoMarkdown({
  content,
  relativePath,
  list,
}: {
  content: string
  relativePath: string
  list: string
}): Task[] {
  const tasks: Task[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const match = line.match(OPEN_TASK_LINE)
    if (!match) continue
    const text = match[1] ?? ''
    const title = cleanTitle(text)
    if (!title) continue
    tasks.push({
      // Unique within one read; nothing joins on it across runs, so line position is enough.
      id: `${relativePath}:${i + 1}`,
      title,
      // Indented sub-content under the task becomes its notes, fed to the model as authoritative
      // context (e.g. "the part is already in the cabinet" → don't suggest buying it).
      notes: collectNotes({ lines, taskIndex: i, taskIndent: indentOf(line) }),
      created: parseLocalDate(text.match(CREATED_DATE)?.[1]),
      lastModified: null,
      due: parseLocalDate(text.match(DUE_DATE)?.[1]),
      list,
    })
  }

  return tasks
}

function indentOf(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0
}

// Collects the lines immediately under a task — more indented than it, not blank, not a checkbox
// (a deeper checkbox is a separate subtask) — as its notes, with the bullet/indent stripped.
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

function cleanTitle(text: string): string {
  return text
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
