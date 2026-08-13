import { readFile } from 'node:fs/promises'
import type { Task, TaskSource } from '../types.js'
import { type ScannedTask, scanFileTasks } from './scan.js'
import { resolveScopedFiles } from './vault.js'

/**
 * Reads open todos from an Obsidian vault on disk. Reads `todos.md` at the vault root by default,
 * or the files/folders named in `lists` (paths relative to the vault root; a folder is walked for
 * its `*.md` files). The vault is read-only here — this never writes or pulls, so it sees whatever
 * the last sync left on disk; keep the vault synced separately (Obsidian Sync or Obsidian Git).
 */
export function createObsidianTaskSource({
  vaultPath,
  lists,
}: {
  vaultPath: string
  lists: readonly string[]
}): TaskSource {
  async function list(): Promise<Task[]> {
    const files = await resolveScopedFiles({ vaultPath, scopes: lists })
    const perFile = await Promise.all(
      files.map(async file => {
        const content = await readFile(file.absPath, 'utf8')
        const scanned = scanFileTasks({ path: file.relativePath, content })

        return scanned.filter(task => task.status === 'open' && task.title !== '').map(toTask)
      }),
    )

    return perFile.flat()
  }

  return { list }
}

// Recurring tasks are kept: the `🔁` rule is stripped from the title and the task is judged by its
// due date like any other, a recurring task being one whose due date rolls forward.
function toTask(scanned: ScannedTask): Task {
  return {
    // Unique within one read; nothing joins on it across runs, so line position is enough.
    id: `${scanned.path}:${scanned.lineNumber}`,
    title: scanned.title,
    // Indented sub-content under the task, fed to the model as authoritative context
    // (e.g. "the part is already in the cabinet" → don't suggest buying it).
    notes: scanned.notes,
    raw: scanned.raw,
    created: scanned.created,
    lastModified: null,
    due: scanned.due,
    list: scanned.list,
  }
}
