import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** One line to replace, matched on `before` so a stale plan can't overwrite a newer edit. */
export type LineChange = {
  /** One-based, so it lines up with what an editor shows. */
  line: number
  before: string
  after: string
}

/**
 * Rewrites only the given lines, leaving every other byte of the file as it was. Returns false when
 * the file was left untouched.
 *
 * Each line is checked against the text it was read as before anything is replaced. A mismatch
 * means the file moved underneath us. Obsidian Sync and the Git plugin are both live on this
 * vault, and an edit in another window lands the same way, so the whole file is skipped rather
 * than half-written. Callers report which files this hit, because a skip that nothing mentions
 * reads exactly like a success.
 */
export async function writeChangedLines({
  absPath,
  changes,
}: {
  absPath: string
  changes: readonly LineChange[]
}): Promise<boolean> {
  const content = await readFile(absPath, 'utf8')
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)

  if (changes.some(change => lines[change.line - 1] !== change.before)) return false

  for (const change of changes) lines[change.line - 1] = change.after
  // Renamed over the file rather than written in place, so a run killed part-way through leaves the
  // vault's previous copy whole. The dot prefix keeps Obsidian from showing the temporary file.
  const temporaryPath = join(dirname(absPath), `.${basename(absPath)}.tmp`)
  await writeFile(temporaryPath, lines.join(eol), 'utf8')
  await rename(temporaryPath, absPath)

  return true
}
