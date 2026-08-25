import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findTranscripts } from './transcripts.js'

async function projectRoot(
  projects: Record<string, string[]>,
): Promise<{ root: string; path: (...parts: string[]) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'session-board-transcripts-'))

  for (const [project, files] of Object.entries(projects)) {
    await mkdir(join(root, project), { recursive: true })
    for (const file of files) await writeFile(join(root, project, file), '')
  }

  return { root, path: (...parts) => join(root, ...parts) }
}

/** Which sessions were found, for the tests that do not care when each was written. */
async function sessionIdsIn(roots: string[]): Promise<Set<string>> {
  return new Set((await findTranscripts({ roots })).keys())
}

it('finds a session by its transcript filename, whatever project holds it', async () => {
  const { root } = await projectRoot({
    '-Users-me-Code-repo': ['aaa.jsonl', 'bbb.jsonl'],
    '-Users-me-Code-other': ['ccc.jsonl'],
  })

  expect(await sessionIdsIn([root])).toEqual(new Set(['aaa', 'bbb', 'ccc']))
})

it('reads every root, since one account cannot see the other one', async () => {
  const work = await projectRoot({ '-Users-me-Code-work': ['aaa.jsonl'] })
  const personal = await projectRoot({ '-Users-me-Code-home': ['bbb.jsonl'] })

  expect(await sessionIdsIn([work.root, personal.root])).toEqual(new Set(['aaa', 'bbb']))
})

it('ignores anything that is not a transcript', async () => {
  const { root } = await projectRoot({ '-Users-me-Code-repo': ['aaa.jsonl', 'notes.md'] })

  expect(await sessionIdsIn([root])).toEqual(new Set(['aaa']))
})

it('treats a root that is not there as holding nothing', async () => {
  expect(await sessionIdsIn(['/nope/not/here'])).toEqual(new Set())
})

it('steps over a loose file sitting among the project directories', async () => {
  const { root } = await projectRoot({ '-Users-me-Code-repo': ['aaa.jsonl'] })
  await writeFile(join(root, 'stray.txt'), '')

  expect(await sessionIdsIn([root])).toEqual(new Set(['aaa']))
})

it('carries the unix seconds each transcript was last written to', async () => {
  const { root, path } = await projectRoot({ '-Users-me-Code-repo': ['aaa.jsonl'] })
  await utimes(path('-Users-me-Code-repo', 'aaa.jsonl'), 1_700_000_000, 1_700_000_000)

  expect((await findTranscripts({ roots: [root] })).get('aaa')).toBe(1_700_000_000)
})

it('keeps the newest write when one session is written under two roots', async () => {
  const work = await projectRoot({ '-Users-me-Code-repo': ['aaa.jsonl'] })
  const personal = await projectRoot({ '-Users-me': ['aaa.jsonl'] })
  await utimes(work.path('-Users-me-Code-repo', 'aaa.jsonl'), 1_700_000_000, 1_700_000_000)
  await utimes(personal.path('-Users-me', 'aaa.jsonl'), 1_700_900_000, 1_700_900_000)

  // Two of the real roots hold copies of the same session, ten days apart. The
  // roots are read at the same time, so whichever answered last used to win: the
  // row's age, and whether the drawer listed it at all, changed at random from
  // one snapshot to the next.
  expect((await findTranscripts({ roots: [work.root, personal.root] })).get('aaa')).toBe(
    1_700_900_000,
  )
  expect((await findTranscripts({ roots: [personal.root, work.root] })).get('aaa')).toBe(
    1_700_900_000,
  )
})
