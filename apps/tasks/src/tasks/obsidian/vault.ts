import { readdir } from 'node:fs/promises'

/**
 * Whether a vault-relative path is one the migration reads.
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
