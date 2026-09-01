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

/**
 * Refuse a template that would take a system prompt path and then drop it.
 *
 * A launch that quietly appended nothing reads as a session ignoring its
 * instructions rather than as a command that never carried them.
 */
function requireSystemPlaceholder(commandTemplate: string): void {
  if (!commandTemplate.includes('{{system}}')) {
    throw new Error('the session command template has no {{system}} in it')
  }
}

export async function openSessionTab({
  sessionId,
  systemPrompt,
  cwd,
  commandTemplate,
}: {
  sessionId: SessionId
  systemPrompt: string
  cwd: string
  commandTemplate: string
}): Promise<void> {
  requireSystemPlaceholder(commandTemplate)

  const systemPromptPath = await writeSystemPromptFile({ sessionId, text: systemPrompt })

  // Unquoted, unlike the same placeholder inside a launch script: this command
  // goes to Ghostty, which quotes the whole string again, so a quote of ours
  // would end that string early. Safe on the same footing as the launch script's
  // own path below, `$TMPDIR` plus a session id the request guard has limited.
  const command = commandTemplate
    .replaceAll('{{id}}', sessionId)
    .replaceAll('{{system}}', systemPromptPath)

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
 * The script that starts one named session, ready to run as `zsh -l <file>`.
 *
 * The command goes into a script file rather than into the command string
 * Ghostty is handed. A session name is whatever was typed into the board, and
 * that string would otherwise cross two shells (Ghostty's `bash -c`, then the
 * login shell) with a different quoting rule at each layer, so a name holding
 * an apostrophe would break the launch and one holding a semicolon would run
 * as a command. Inside a file there are no layers left to escape from.
 */
export function buildSessionScript({
  name,
  prompt,
  systemPromptPath,
  commandTemplate,
}: {
  name: string
  prompt?: string | undefined
  systemPromptPath: string
  commandTemplate: string
}): string {
  requireSystemPlaceholder(commandTemplate)

  const command = commandTemplate
    .replaceAll('{{name}}', shellQuote(name))
    .replaceAll('{{system}}', shellQuote(systemPromptPath))
    // A session started with nothing to read has no first prompt, and the
    // placeholder is removed along with the space in front of it rather than
    // filled with an empty pair of quotes: Claude Code would take that as a
    // first prompt that happens to be blank and answer it.
    .replaceAll(/ *\{\{prompt\}\}/g, prompt === undefined ? '' : ` ${shellQuote(prompt)}`)

  // `exec` so the login shell is replaced rather than left waiting: the tab's
  // process is then Claude Code itself, and closing the tab reaches it.
  return `#!/bin/zsh -l\nexec ${command}\n`
}

export function buildProgressScript({
  name,
  progressPath,
  systemPromptPath,
  commandTemplate,
  promptTemplate,
}: {
  name: string
  progressPath: string
  systemPromptPath: string
  commandTemplate: string
  promptTemplate: string
}): string {
  return buildSessionScript({
    name,
    prompt: promptTemplate.replaceAll('{{progress}}', progressPath),
    systemPromptPath,
    commandTemplate,
  })
}

/**
 * Join the parts of one session's appended system prompt.
 *
 * Claude Code reads only the last `--append-system-prompt-file` on a command
 * line, so a launch that has two things to say cannot say them in two files.
 */
export function buildSystemPrompt(parts: (string | undefined)[]): string {
  return parts
    .map(part => part?.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Write one session's appended system prompt, and answer where it landed.
 *
 * Claude Code reads it once, as it starts, so the file only has to outlive the
 * launch. Named after the session id, the way the launch script is.
 */
async function writeSystemPromptFile({
  sessionId,
  text,
}: {
  sessionId: SessionId
  text: string
}): Promise<string> {
  const path = join(tmpdir(), `session-board-system-${sessionId}.md`)
  await writeFile(path, `${text}\n`, { mode: 0o600 })

  return path
}

/**
 * Run a built launch script in a new tab.
 *
 * The path is built from the session id, which the request guard has already
 * limited to `[A-Za-z0-9._-]`, so the path itself needs no quoting and each
 * session reuses one file instead of leaving a trail of them.
 */
async function openScriptInTab({
  sessionId,
  script,
  cwd,
}: {
  sessionId: SessionId
  script: string
  cwd: string
}): Promise<void> {
  const scriptPath = join(tmpdir(), `session-board-launch-${sessionId}.sh`)
  await writeFile(scriptPath, script, { mode: 0o700 })

  await execFileAsync('osascript', [
    '-e',
    NEW_TAB_SCRIPT,
    `/bin/zsh -l ${scriptPath}`,
    resolveLaunchCwd(cwd),
  ])
}

export async function openSessionFromProgress({
  sessionId,
  name,
  progressPath,
  systemPrompt,
  cwd,
  commandTemplate,
  promptTemplate,
}: {
  sessionId: SessionId
  name: string
  progressPath: string
  systemPrompt: string
  cwd: string
  commandTemplate: string
  promptTemplate: string
}): Promise<void> {
  // Before the write, not after: `buildSessionScript` checks the same thing, but
  // by then a rejected launch has already left a file in the temp directory.
  requireSystemPlaceholder(commandTemplate)

  const systemPromptPath = await writeSystemPromptFile({ sessionId, text: systemPrompt })

  await openScriptInTab({
    sessionId,
    script: buildProgressScript({
      name,
      progressPath,
      systemPromptPath,
      commandTemplate,
      promptTemplate,
    }),
    cwd,
  })
}

/**
 * Start a session that has no past at all, for a row the board is inventing.
 *
 * The prompt is optional here and required by `openSessionFromProgress`: a
 * session with no progress file, or with one that was just written and is
 * empty, has nothing to read and starts on an empty conversation the way one
 * typed by hand does.
 */
export async function openNewSession({
  sessionId,
  name,
  prompt,
  systemPrompt,
  cwd,
  commandTemplate,
}: {
  sessionId: SessionId
  name: string
  prompt?: string | undefined
  systemPrompt: string
  cwd: string
  commandTemplate: string
}): Promise<void> {
  requireSystemPlaceholder(commandTemplate)

  const systemPromptPath = await writeSystemPromptFile({ sessionId, text: systemPrompt })

  await openScriptInTab({
    sessionId,
    script: buildSessionScript({ name, prompt, systemPromptPath, commandTemplate }),
    cwd,
  })
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
