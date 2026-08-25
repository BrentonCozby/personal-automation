import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
//
// A tab needs a window to go in, and `tell application` launches Ghostty when it
// is closed but does not wait for its first window, so a board that outlives the
// terminal (this one runs under launchd) has to be able to make one. `new
// window` takes the same configuration and is what the board uses when it finds
// no window to add to.
const NEW_TAB_SCRIPT = `on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to item 1 of argv
    set initial working directory of cfg to item 2 of argv
    try
      if (count of windows) is 0 then
        new window with configuration cfg
      else
        new tab with configuration cfg
      end if
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

/**
 * Wrap a value so a shell reads it as one word, whatever is inside it.
 *
 * Single quotes suspend every other kind of expansion, so the only character
 * that needs handling is the single quote itself: close the string, add an
 * escaped one, open it again.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Start a new session on the work a progress file describes.
 *
 * The command goes into a script file rather than into the command string
 * Ghostty is handed. A session name is whatever was typed into the board, and
 * that string would otherwise cross two shells (Ghostty's `bash -c`, then the
 * login shell) with a different quoting rule at each layer, so a name holding
 * an apostrophe would break the launch and one holding a semicolon would run
 * as a command. Inside a file there are no layers left to escape from.
 *
 * The path is built from the session id, which the request guard has already
 * limited to `[A-Za-z0-9._-]`, so the path itself needs no quoting and each
 * session reuses one file instead of leaving a trail of them.
 */
export function buildProgressScript({
  name,
  progressPath,
  commandTemplate,
  promptTemplate,
}: {
  name: string
  progressPath: string
  commandTemplate: string
  promptTemplate: string
}): string {
  const prompt = promptTemplate.replaceAll('{{progress}}', progressPath)
  const command = commandTemplate
    .replaceAll('{{name}}', shellQuote(name))
    .replaceAll('{{prompt}}', shellQuote(prompt))

  // `exec` so the login shell is replaced rather than left waiting: the tab's
  // process is then Claude Code itself, and closing the tab reaches it.
  return `#!/bin/zsh -l\nexec ${command}\n`
}

export async function openSessionFromProgress({
  sessionId,
  name,
  progressPath,
  cwd,
  commandTemplate,
  promptTemplate,
}: {
  sessionId: SessionId
  name: string
  progressPath: string
  cwd: string
  commandTemplate: string
  promptTemplate: string
}): Promise<void> {
  const scriptPath = join(tmpdir(), `session-board-launch-${sessionId}.sh`)
  await writeFile(
    scriptPath,
    buildProgressScript({ name, progressPath, commandTemplate, promptTemplate }),
    { mode: 0o700 },
  )

  await execFileAsync('osascript', [
    '-e',
    NEW_TAB_SCRIPT,
    `/bin/zsh -l ${scriptPath}`,
    resolveLaunchCwd(cwd),
  ])
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
