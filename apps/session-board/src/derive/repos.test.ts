import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { HookEvent } from '../events/types.js'
import {
  collectGroupDirectories,
  collectSessionDirectories,
  createRepoRoots,
  isThrowawayRoot,
} from './repos.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args])
}

// macOS hands back /var/folders/..., a symlink to /private/var/folders/...,
// while git always answers with the resolved path.
async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'session-board-')))
}

function event({ sessionId, cwd }: { sessionId: string; cwd?: string }): HookEvent {
  return { session_id: sessionId, hook_event_name: 'SessionStart', t: 100, ...(cwd ? { cwd } : {}) }
}

it('collects a directory from an event', () => {
  const directories = collectSessionDirectories({
    events: [event({ sessionId: 'a', cwd: '/repo' })],
    metadata: {},
  })

  expect(directories).toEqual(['/repo'])
})

it('collects a directory a row remembers but no event carries', () => {
  const directories = collectSessionDirectories({
    events: [],
    metadata: { a: { cwd: '/imported' } },
  })

  expect(directories).toEqual(['/imported'])
})

it('reports each directory once however many sessions used it', () => {
  const directories = collectSessionDirectories({
    events: [event({ sessionId: 'a', cwd: '/repo' }), event({ sessionId: 'b', cwd: '/repo' })],
    metadata: { c: { cwd: '/repo' } },
  })

  expect(directories).toEqual(['/repo'])
})

it('skips an event that carries no directory', () => {
  const directories = collectSessionDirectories({
    events: [event({ sessionId: 'a' })],
    metadata: {},
  })

  expect(directories).toEqual([])
})

it('counts a throwaway repo out', () => {
  expect(isThrowawayRoot('/private/tmp/board-probe')).toBe(true)
  expect(isThrowawayRoot('/tmp/board-probe')).toBe(true)
  expect(isThrowawayRoot('/Users/me/Code/marketplace')).toBe(false)
})

// A directory named /tmpfiles starts with the same letters and is a real place
// to keep a repository.
it('counts a directory that merely starts with tmp in', () => {
  expect(isThrowawayRoot('/tmpfiles/repo')).toBe(false)
})

it('answers the root itself for a directory that is one', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')

  expect(await createRepoRoots().list([root])).toEqual([root])
})

it('collapses a subdirectory onto its root', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')
  const nested = join(root, 'packages', 'common')
  await mkdir(nested, { recursive: true })

  expect(await createRepoRoots().list([nested])).toEqual([root])
})

it('collapses a worktree onto the repository it belongs to', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')
  await git(root, 'commit', '-q', '--allow-empty', '-m', 'first')
  const worktree = join(await tempDir(), 'wt')
  await git(root, 'worktree', 'add', '-q', worktree, '-b', 'side')

  expect(await createRepoRoots().list([worktree])).toEqual([root])
})

// The reason worktrees are excluded rather than offered: a progress file lives
// at the real root, so a repository the board has only ever seen through a
// worktree still has to be offerable.
it('offers a repository only ever seen through a worktree', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')
  await git(root, 'commit', '-q', '--allow-empty', '-m', 'first')
  const worktree = join(await tempDir(), 'only-wt')
  await git(root, 'worktree', 'add', '-q', worktree, '-b', 'side')

  expect(await createRepoRoots().list([worktree])).toContain(root)
})

it('drops a directory that is in no repository', async () => {
  const plain = await tempDir()

  expect(await createRepoRoots().list([plain])).toEqual([])
})

it('drops a directory that no longer exists', async () => {
  expect(await createRepoRoots().list(['/Users/nobody/gone-worktrees/deleted'])).toEqual([])
})

it('drops a throwaway repository', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/session-board-probe-'))
  await git(root, 'init', '-q')

  expect(await createRepoRoots().list([root])).toEqual([])
})

it('puts the root that most directories collapsed onto first', async () => {
  const busy = await tempDir()
  const quiet = await tempDir()
  await git(busy, 'init', '-q')
  await git(quiet, 'init', '-q')
  const nested = join(busy, 'apps')
  await mkdir(nested)

  expect(await createRepoRoots().list([quiet, busy, nested])).toEqual([busy, quiet])
})

it('breaks a tie on the path, so the order never wobbles between requests', async () => {
  // Named rather than two mkdtemp paths: those carry a random suffix, and a
  // test that works its own expectation out with a second comparator disagrees
  // with the code whenever the two order case differently.
  const parent = await tempDir()
  const alpha = join(parent, 'alpha')
  const beta = join(parent, 'beta')
  await mkdir(alpha)
  await mkdir(beta)
  await git(alpha, 'init', '-q')
  await git(beta, 'init', '-q')

  expect(await createRepoRoots().list([beta, alpha])).toEqual([alpha, beta])
})

// Taking the repository away is how the test sees that git was not asked twice:
// a lookup that went again would find nothing there.
it('remembers a root it has already answered', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')
  const repoRoots = createRepoRoots()
  expect(await repoRoots.list([root])).toEqual([root])

  await rm(join(root, '.git'), { recursive: true })

  expect(await repoRoots.list([root])).toEqual([root])
})

// The other half of the same saving: 28 of the 76 directories in the real log
// are in no repository, and they cost a process each.
it('remembers that a directory is in no repository', async () => {
  const plain = await tempDir()
  const repoRoots = createRepoRoots()
  expect(await repoRoots.list([plain])).toEqual([])

  await git(plain, 'init', '-q')

  expect(await repoRoots.list([plain])).toEqual([])
})

// Held per board rather than per module, which is what lets a test drive a
// lookup that has seen nothing.
it('answers a fresh lookup from disk rather than from what another one found', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')
  expect(await createRepoRoots().list([root])).toEqual([root])

  await rm(join(root, '.git'), { recursive: true })

  expect(await createRepoRoots().list([root])).toEqual([])
})

it("collects only the directories of one group's sessions", () => {
  const directories = collectGroupDirectories({
    events: [
      event({ sessionId: 'a', cwd: '/marketplace-worktrees/soc2' }),
      event({ sessionId: 'b', cwd: '/interviews' }),
    ],
    metadata: { a: { group: 'Bug week' }, b: { group: 'Interviewing' } },
    group: 'Bug week',
  })

  expect(directories).toEqual(['/marketplace-worktrees/soc2'])
})

it("falls back to a row's own directory for a session with no events", () => {
  const directories = collectGroupDirectories({
    events: [],
    metadata: { a: { group: 'Stash', cwd: '/imported' } },
    group: 'Stash',
  })

  expect(directories).toEqual(['/imported'])
})

// The `home` group on the real board is exactly this: one row whose session
// never reported a directory.
it('collects nothing for a group whose rows know no directory', () => {
  const directories = collectGroupDirectories({
    events: [],
    metadata: { a: { group: 'home', name: 'session-board' } },
    group: 'home',
  })

  expect(directories).toEqual([])
})
