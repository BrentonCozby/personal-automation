import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SessionId } from './request-guard.js'

const execFileAsync = promisify(execFile)

// Values arrive as AppleScript's `argv` rather than being pasted into the
// script text. A repo path holding a quote or a backslash would otherwise close
// the string literal early and the remainder would run as script.
//
// `new tab` answers errAEEventNotHandled (-1708) even though it does create the
// tab, so the failure is swallowed. Ghostty's own `+new-window` action refuses
// to run on macOS, and `open -na Ghostty` starts a second Ghostty application
// rather than adding a tab, so this is the only route that lands in the window
// that is already open.
const NEW_TAB_SCRIPT = `on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to item 1 of argv
    set initial working directory of cfg to item 2 of argv
    try
      new tab with configuration cfg
    end try
  end tell
end run`

/**
 * Flatten `..` out of a working directory before a session is resumed there.
 *
 * Claude Code names the directory it keeps a session's transcript in after the
 * literal working directory string, so `<repo>/../<repo>-worktrees/soc2` and
 * `<repo>-worktrees/soc2` are two different projects to it even though they are
 * one directory. Resuming from the unflattened form looks in a project that
 * does not exist, and Claude Code opens some other session instead of the one
 * that was asked for. Worth doing here rather than only at the point the paths
 * are read in, since any source of a path can carry `..`.
 */
export function resolveLaunchCwd(cwd: string): string {
  return resolve(cwd)
}

export async function openSessionTab({
  sessionId,
  cwd,
  commandTemplate,
}: {
  sessionId: SessionId
  cwd: string
  commandTemplate: string
}): Promise<void> {
  const command = commandTemplate.replaceAll('{{id}}', sessionId)

  await execFileAsync('osascript', ['-e', NEW_TAB_SCRIPT, command, resolveLaunchCwd(cwd)])
}

/** Split a configured command into argv, so it can run without a shell. */
export function buildOpenFileArgv({
  template,
  path,
}: {
  template: string
  path: string
}): string[] {
  return template
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.replaceAll('{{path}}', path))
}

export async function openFile({
  path,
  commandTemplate,
}: {
  path: string
  commandTemplate: string
}): Promise<void> {
  const [command, ...args] = buildOpenFileArgv({ template: commandTemplate, path })
  if (!command) throw new Error('BOARD_OPEN_FILE_COMMAND is empty')

  await execFileAsync(command, args)
}
