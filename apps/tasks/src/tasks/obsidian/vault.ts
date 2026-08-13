import type { Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { AppError } from '@personal-automation/common/errors'

// With no configured scope, only this inbox file at the vault root is read. Reading the whole
// vault would sweep in incidental `- [ ]` checkboxes from notes and templates that aren't todos.
export const DEFAULT_TODOS_FILE = 'todos.md'

/**
 * Whether a vault-relative path is one this app reads when walking a folder.
 *
 * Every dot-prefixed folder is skipped, which covers Obsidian's `.trash` (deleted copies, whose
 * tasks would otherwise be resurrected into the plan), `.obsidian` (plugin code and READMEs), and
 * `.git`, without needing a list that drifts as plugins come and go.
 */
export function isScannablePath(relativePath: string): boolean {
  if (!relativePath.endsWith('.md')) return false

  return !relativePath.split('/').some(segment => segment.startsWith('.'))
}

/** Every scannable Markdown file in the vault, as paths relative to its root. */
export async function findMarkdownFiles(vaultPath: string): Promise<string[]> {
  const entries = await readdir(vaultPath, { recursive: true })

  // readdir returns platform separators; the vault's own paths are POSIX-style everywhere the
  // app reports them, so normalise once here rather than at every use site.
  return entries.map(entry => entry.split('\\').join('/')).filter(isScannablePath)
}

/** One Markdown file to read, resolved from a configured scope. */
export type ScopedFile = {
  absPath: string
  /** Vault-relative, POSIX-style. */
  relativePath: string
}

/**
 * The files a configured scope names: `scopes` are file and folder paths relative to the vault
 * root, a folder being walked for the Markdown files under it. An empty scope reads only
 * `todos.md` at the vault root.
 *
 * A scope that doesn't exist throws rather than resolving to nothing, because an empty read looks
 * exactly like "you have no tasks".
 */
export async function resolveScopedFiles({
  vaultPath,
  scopes,
}: {
  vaultPath: string
  scopes: readonly string[]
}): Promise<ScopedFile[]> {
  await assertDirectory(vaultPath)
  const entries = scopes.length === 0 ? [DEFAULT_TODOS_FILE] : scopes
  const files: ScopedFile[] = []
  for (const entry of entries) {
    const absPath = join(vaultPath, entry)
    const info = await statOrThrow({ path: absPath, entry })
    if (!info.isDirectory()) {
      files.push(toScopedFile({ vaultPath, absPath }))
      continue
    }
    const found = await readdir(absPath, { recursive: true })
    for (const rel of found) {
      const relativeToVault = relative(vaultPath, join(absPath, rel)).split('\\').join('/')
      if (isScannablePath(relativeToVault)) {
        files.push(toScopedFile({ vaultPath, absPath: join(absPath, rel) }))
      }
    }
  }

  return files
}

function toScopedFile({ vaultPath, absPath }: { vaultPath: string; absPath: string }): ScopedFile {
  return { absPath, relativePath: relative(vaultPath, absPath).split('\\').join('/') }
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
