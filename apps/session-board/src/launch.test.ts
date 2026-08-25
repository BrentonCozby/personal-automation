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
  resolveLaunchCwd,
  shellQuote,
} from './launch.js'

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
      commandTemplate: 'claude-auto -n {{name}} {{prompt}}',
      promptTemplate: 'Read {{progress}} and carry on.',
    }),
  )

  expect(argv).toEqual([
    '-n',
    'review perf',
    'Read /repo/marketplace-perf.progress.local.md and carry on.',
  ])
})

it('keeps a name holding an apostrophe in one piece', async () => {
  const argv = await argvFromScript(
    buildProgressScript({
      name: "don't ship",
      progressPath: '/repo/x.progress.local.md',
      commandTemplate: 'claude-auto -n {{name}} {{prompt}}',
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
      commandTemplate: 'claude-auto -n {{name}} {{prompt}}',
      promptTemplate: 'Read {{progress}}.',
    }),
  )

  // Reaches the binary as text. Unquoted it would have run two commands.
  expect(argv).toEqual(['-n', '$(whoami); echo pwned', 'Read /repo/x.progress.local.md.'])
})

it('passes only the name when the new session has nothing to read', async () => {
  const argv = await argvFromScript(
    buildSessionScript({
      name: 'review-perf',
      commandTemplate: 'claude-auto -n {{name}} {{prompt}}',
    }),
  )

  // Two arguments, not three. An empty pair of quotes would have reached Claude
  // Code as a first prompt that happens to be blank.
  expect(argv).toEqual(['-n', 'review-perf'])
})

it('quotes a name that needs it even with no prompt to follow', async () => {
  const argv = await argvFromScript(
    buildSessionScript({
      name: '$(whoami); echo pwned',
      commandTemplate: 'claude-auto -n {{name}} {{prompt}}',
    }),
  )

  expect(argv).toEqual(['-n', '$(whoami); echo pwned'])
})
