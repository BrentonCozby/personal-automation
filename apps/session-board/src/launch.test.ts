import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  buildOpenFileArgv,
  buildProgressScript,
  buildSessionScript,
  buildSystemPrompt,
  openSessionTab,
  resolveLaunchCwd,
  shellQuote,
} from './launch.js'
import { isSessionId, type SessionId } from './request-guard.js'

const TEMPLATE = 'claude-auto -n {{name}} --append-system-prompt-file {{system}} {{prompt}}'
const SYSTEM_PATH = '/tmp/session-board-system-abc.md'

const execFileAsync = promisify(execFile)

it('flattens a worktree path that walks back up through its parent', () => {
  expect(resolveLaunchCwd('/repo/applications/marketplace/../marketplace-worktrees/soc2')).toBe(
    '/repo/applications/marketplace-worktrees/soc2',
  )
})

it('leaves a path that is already flat alone', () => {
  expect(resolveLaunchCwd('/repo/applications/marketplace-worktrees/soc2')).toBe(
    '/repo/applications/marketplace-worktrees/soc2',
  )
})

it('substitutes the path into its own argument', () => {
  const argv = buildOpenFileArgv({
    template: 'code -- {{path}}',
    path: '/repo/impact-scoring.progress.local.md',
  })

  expect(argv).toEqual(['code', '--', '/repo/impact-scoring.progress.local.md'])
})

it('keeps a path with spaces in one argument, since no shell splits it later', () => {
  const argv = buildOpenFileArgv({
    template: 'code -- {{path}}',
    path: '/repo/my notes.progress.local.md',
  })

  expect(argv).toEqual(['code', '--', '/repo/my notes.progress.local.md'])
})

it('tolerates padding around the template', () => {
  expect(buildOpenFileArgv({ template: '  open   -t  {{path}} ', path: '/a.md' })).toEqual([
    'open',
    '-t',
    '/a.md',
  ])
})

it('wraps a plain value so the shell reads it as one word', () => {
  expect(shellQuote('review perf')).toBe("'review perf'")
})

it('survives the apostrophe that would otherwise end the quoted string early', () => {
  // A session you named "don't ship" is the ordinary case this exists for, not
  // an attack: unquoted, it ends the string and the rest runs as a command.
  expect(shellQuote("don't ship")).toBe(`'don'\\''t ship'`)
})

it('leaves a value holding shell syntax as text', async () => {
  const quoted = shellQuote('x; rm -rf /; echo $HOME `whoami`')
  const { stdout } = await execFileAsync('/bin/zsh', ['-c', `printf %s ${quoted}`])

  // Run through a real shell: what comes back is the string, not its effect.
  expect(stdout).toBe('x; rm -rf /; echo $HOME `whoami`')
})

it('round-trips a quoted value through a real shell unchanged', async () => {
  for (const value of ["it's", 'a b', '$PATH', '"quoted"', 'back\\slash', 'new\nline']) {
    const { stdout } = await execFileAsync('/bin/zsh', ['-c', `printf %s ${shellQuote(value)}`])

    expect(stdout).toBe(value)
  }
})

/**
 * Run a built launch script with a stub standing in for the real binary, so
 * what the shell actually passed as argv comes back one word per line.
 */
async function argvFromScript(script: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'session-board-launch-'))
  const stub = join(dir, 'claude-auto')
  await writeFile(stub, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 })

  const scriptPath = join(dir, 'launch.sh')
  await writeFile(scriptPath, script.replace('exec claude-auto', `exec ${stub}`), { mode: 0o700 })
  const { stdout } = await execFileAsync('/bin/zsh', [scriptPath])

  return stdout.split('\n').slice(0, -1)
}

it('passes the name and the prompt as one argument each', async () => {
  const argv = await argvFromScript(
    buildProgressScript({
      name: 'review perf',
      progressPath: '/repo/marketplace-perf.progress.local.md',
      systemPromptPath: SYSTEM_PATH,
      commandTemplate: TEMPLATE,
      promptTemplate: 'Read {{progress}} and carry on.',
    }),
  )

  expect(argv).toEqual([
    '-n',
    'review perf',
    '--append-system-prompt-file',
    SYSTEM_PATH,
    'Read /repo/marketplace-perf.progress.local.md and carry on.',
  ])
})

it('keeps a name holding an apostrophe in one piece', async () => {
  const argv = await argvFromScript(
    buildProgressScript({
      name: "don't ship",
      progressPath: '/repo/x.progress.local.md',
      systemPromptPath: SYSTEM_PATH,
      commandTemplate: TEMPLATE,
      promptTemplate: 'Read {{progress}}.',
    }),
  )

  expect(argv[1]).toBe("don't ship")
})

it('treats shell syntax in a name as part of the name', async () => {
  const argv = await argvFromScript(
    buildProgressScript({
      name: '$(whoami); echo pwned',
      progressPath: '/repo/x.progress.local.md',
      systemPromptPath: SYSTEM_PATH,
      commandTemplate: TEMPLATE,
      promptTemplate: 'Read {{progress}}.',
    }),
  )

  // Reaches the binary as text. Unquoted it would have run two commands.
  expect(argv).toEqual([
    '-n',
    '$(whoami); echo pwned',
    '--append-system-prompt-file',
    SYSTEM_PATH,
    'Read /repo/x.progress.local.md.',
  ])
})

it('keeps a system prompt path holding a space in one argument', async () => {
  const argv = await argvFromScript(
    buildSessionScript({
      name: 'review-perf',
      systemPromptPath: '/var/folders/T x/session-board-system-abc.md',
      commandTemplate: TEMPLATE,
    }),
  )

  expect(argv.at(-1)).toBe('/var/folders/T x/session-board-system-abc.md')
})

it('refuses a template that would drop the appended system prompt', () => {
  expect(() =>
    buildSessionScript({
      name: 'review-perf',
      systemPromptPath: SYSTEM_PATH,
      commandTemplate: 'claude-auto -n {{name}} {{prompt}}',
    }),
  ).toThrow('{{system}}')
})

it('passes only the name and the system prompt when there is nothing to read', async () => {
  const argv = await argvFromScript(
    buildSessionScript({
      name: 'review-perf',
      systemPromptPath: SYSTEM_PATH,
      commandTemplate: TEMPLATE,
    }),
  )

  // Four arguments, not five. An empty pair of quotes would have reached Claude
  // Code as a first prompt that happens to be blank.
  expect(argv).toEqual(['-n', 'review-perf', '--append-system-prompt-file', SYSTEM_PATH])
})

it('quotes a name that needs it even with no prompt to follow', async () => {
  const argv = await argvFromScript(
    buildSessionScript({
      name: '$(whoami); echo pwned',
      systemPromptPath: SYSTEM_PATH,
      commandTemplate: TEMPLATE,
    }),
  )

  expect(argv).toEqual(['-n', '$(whoami); echo pwned', '--append-system-prompt-file', SYSTEM_PATH])
})

function asSessionId(value: string): SessionId {
  if (!isSessionId(value)) throw new Error(`${value} is not a session id`)

  return value
}

it('rejects a resume template with no {{system}} before it opens a tab', async () => {
  // The check has to come before the tab, not inside the script the tab runs:
  // this path hands its command straight to Ghostty, so a launch that got past
  // here would be a real window with the grant missing.
  await expect(
    openSessionTab({
      sessionId: asSessionId('abc'),
      systemPrompt: 'Subagents are allowed.',
      cwd: '/repo',
      commandTemplate: 'claude --resume {{id}}',
    }),
  ).rejects.toThrow('{{system}}')
})

it('separates the parts of one appended system prompt', () => {
  expect(buildSystemPrompt(['Subagents are allowed.', 'No progress file.'])).toBe(
    'Subagents are allowed.\n\nNo progress file.',
  )
})

it('drops the parts that do not apply to this launch', () => {
  // The caller passes a slot per note and leaves the ones that are off absent,
  // so what arrives is mostly nothing. Keeping those slots would open the
  // appended prompt with the blank lines of two notes never written.
  expect(buildSystemPrompt(['Subagents are allowed.', undefined, '   '])).toBe(
    'Subagents are allowed.',
  )
})
