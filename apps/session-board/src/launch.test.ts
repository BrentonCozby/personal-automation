import { expect, it } from 'vitest'
import { buildOpenFileArgv, resolveLaunchCwd } from './launch.js'

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
