import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  findProgressFiles,
  listProgressCandidates,
  matchProgressFile,
  progressSlug,
  resolveRepoRoot,
} from './progress-files.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args])
}

// macOS hands back /var/folders/..., a symlink to /private/var/folders/...,
// while git always answers with the resolved path.
async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'session-board-')))
}

it('strips the suffix so a row shows only the slug', () => {
  expect(progressSlug('/repo/mkpl-856-rollout.progress.local.md')).toBe('mkpl-856-rollout')
})

it('resolves the repo root from the root itself', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')

  expect(await resolveRepoRoot(root)).toBe(root)
})

it('resolves the repo root from a subdirectory', async () => {
  const root = await tempDir()
  await git(root, 'init', '-q')
  const nested = join(root, 'apps', 'thing')
  await execFileAsync('mkdir', ['-p', nested])

  expect(await resolveRepoRoot(nested)).toBe(root)
})

it('resolves a linked worktree to the real repo root, not the worktree', async () => {
  // The case the whole function exists for. --show-toplevel would answer with
  // the worktree, where no progress file lives.
  const root = await tempDir()
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test')
  await writeFile(join(root, 'README.md'), 'seed\n', 'utf8')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-qm', 'seed')

  const worktree = join(await tempDir(), 'feature')
  await git(root, 'worktree', 'add', '-q', '-b', 'feature', worktree)

  expect(await resolveRepoRoot(worktree)).toBe(root)
})

it('reports no repo root outside a repository', async () => {
  expect(await resolveRepoRoot(await tempDir())).toBeUndefined()
})

it('finds only progress files, sorted', async () => {
  const root = await tempDir()
  await writeFile(join(root, 'b-task.progress.local.md'), '', 'utf8')
  await writeFile(join(root, 'a-task.progress.local.md'), '', 'utf8')
  await writeFile(join(root, 'README.md'), '', 'utf8')

  expect(await findProgressFiles(root)).toEqual([
    join(root, 'a-task.progress.local.md'),
    join(root, 'b-task.progress.local.md'),
  ])
})

it('finds nothing in a directory that is gone', async () => {
  expect(await findProgressFiles('/nope/not/here')).toEqual([])
})

it('offers every progress file with its slug', async () => {
  const root = await tempDir()
  await writeFile(join(root, 'b-task.progress.local.md'), '', 'utf8')
  await writeFile(join(root, 'a-task.progress.local.md'), '', 'utf8')

  expect(await listProgressCandidates({ repoRoot: root, metadata: {}, sessionId: 's1' })).toEqual([
    { path: join(root, 'a-task.progress.local.md'), slug: 'a-task', linkedTo: undefined },
    { path: join(root, 'b-task.progress.local.md'), slug: 'b-task', linkedTo: undefined },
  ])
})

it('names the session already using a file so two rows do not take one file unknowingly', async () => {
  const root = await tempDir()
  const taken = join(root, 'a-task.progress.local.md')
  await writeFile(taken, '', 'utf8')

  const candidates = await listProgressCandidates({
    repoRoot: root,
    metadata: { s2: { name: 'other-session', progressPath: taken } },
    sessionId: 's1',
  })

  expect(candidates[0]?.linkedTo).toBe('other-session')
})

it('falls back to the session id when the session holding a file has no name', async () => {
  const root = await tempDir()
  const taken = join(root, 'a-task.progress.local.md')
  await writeFile(taken, '', 'utf8')

  const candidates = await listProgressCandidates({
    repoRoot: root,
    metadata: { s2: { progressPath: taken } },
    sessionId: 's1',
  })

  expect(candidates[0]?.linkedTo).toBe('s2')
})

it('does not report the asking session as holding its own file', async () => {
  const root = await tempDir()
  const mine = join(root, 'a-task.progress.local.md')
  await writeFile(mine, '', 'utf8')

  const candidates = await listProgressCandidates({
    repoRoot: root,
    metadata: { s1: { name: 'mine', progressPath: mine } },
    sessionId: 's1',
  })

  expect(candidates[0]?.linkedTo).toBeUndefined()
})

it('links a file whose slug is exactly the session name', () => {
  const matched = matchProgressFile({
    candidates: ['/repo/impact-scoring.progress.local.md', '/repo/other.progress.local.md'],
    sessionName: 'impact-scoring',
    unlinkedSessionCount: 3,
  })

  expect(matched).toBe('/repo/impact-scoring.progress.local.md')
})

it('refuses a near-miss name rather than linking the wrong file', () => {
  // "impact" against "impact-scoring" is the real mismatch this guards against.
  const matched = matchProgressFile({
    candidates: ['/repo/impact-scoring.progress.local.md', '/repo/other.progress.local.md'],
    sessionName: 'impact',
    unlinkedSessionCount: 3,
  })

  expect(matched).toBeUndefined()
})

it('links the only file when only one session is missing one', () => {
  const matched = matchProgressFile({
    candidates: ['/repo/only.progress.local.md'],
    sessionName: 'unrelated-name',
    unlinkedSessionCount: 1,
  })

  expect(matched).toBe('/repo/only.progress.local.md')
})

it('gives up when one file could belong to either of two sessions', () => {
  const matched = matchProgressFile({
    candidates: ['/repo/only.progress.local.md'],
    sessionName: 'unrelated-name',
    unlinkedSessionCount: 2,
  })

  expect(matched).toBeUndefined()
})

it('gives up when one session could take either of two files', () => {
  const matched = matchProgressFile({
    candidates: ['/repo/one.progress.local.md', '/repo/two.progress.local.md'],
    sessionName: 'unrelated-name',
    unlinkedSessionCount: 1,
  })

  expect(matched).toBeUndefined()
})

it('prefers the exact name over the only-one-left shortcut', () => {
  const matched = matchProgressFile({
    candidates: ['/repo/wanted.progress.local.md', '/repo/decoy.progress.local.md'],
    sessionName: 'wanted',
    unlinkedSessionCount: 1,
  })

  expect(matched).toBe('/repo/wanted.progress.local.md')
})

it('still links the only file for a session with no name', () => {
  const matched = matchProgressFile({
    candidates: ['/repo/only.progress.local.md'],
    unlinkedSessionCount: 1,
  })

  expect(matched).toBe('/repo/only.progress.local.md')
})

it('links nothing when the repo has no progress files', () => {
  expect(
    matchProgressFile({ candidates: [], sessionName: 'x', unlinkedSessionCount: 1 }),
  ).toBeUndefined()
})
