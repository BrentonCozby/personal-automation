import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findTranscriptSessionIds } from './transcripts.js'

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

it('finds a session by its transcript filename, whatever project holds it', async () => {
  const { root } = await projectRoot({
    '-Users-me-Code-repo': ['aaa.jsonl', 'bbb.jsonl'],
    '-Users-me-Code-other': ['ccc.jsonl'],
  })

  expect(await findTranscriptSessionIds({ roots: [root] })).toEqual(new Set(['aaa', 'bbb', 'ccc']))
})

it('reads every root, since one account cannot see the other one', async () => {
  const work = await projectRoot({ '-Users-me-Code-work': ['aaa.jsonl'] })
  const personal = await projectRoot({ '-Users-me-Code-home': ['bbb.jsonl'] })

  expect(await findTranscriptSessionIds({ roots: [work.root, personal.root] })).toEqual(
    new Set(['aaa', 'bbb']),
  )
})

it('ignores anything that is not a transcript', async () => {
  const { root } = await projectRoot({ '-Users-me-Code-repo': ['aaa.jsonl', 'notes.md'] })

  expect(await findTranscriptSessionIds({ roots: [root] })).toEqual(new Set(['aaa']))
})

it('treats a root that is not there as holding nothing', async () => {
  expect(await findTranscriptSessionIds({ roots: ['/nope/not/here'] })).toEqual(new Set())
})

it('steps over a loose file sitting among the project directories', async () => {
  const { root } = await projectRoot({ '-Users-me-Code-repo': ['aaa.jsonl'] })
  await writeFile(join(root, 'stray.txt'), '')

  expect(await findTranscriptSessionIds({ roots: [root] })).toEqual(new Set(['aaa']))
})
