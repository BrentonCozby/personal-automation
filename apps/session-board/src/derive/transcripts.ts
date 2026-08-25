import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const TRANSCRIPT_SUFFIX = '.jsonl'

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    // A root that is not there, or a stray file among the project directories.
    if (code === 'ENOENT' || code === 'ENOTDIR') return []

    throw error
  }
}

/**
 * Every session Claude Code still holds a transcript for.
 *
 * Found by listing the project directories rather than by working out where a
 * given session's transcript ought to be. Claude Code names a project directory
 * after the directory the session *started* in, and a session that moves (a
 * `cd`, or a subagent working in a scratchpad) keeps its transcript where it
 * began. Nine of twenty-six real sessions had moved, so a path built from the
 * directory a session last reported would have called a third of the board
 * unresumable.
 *
 * Listing all of them costs about 9ms for 710 transcripts across 88 project
 * directories, which is why it runs per snapshot rather than being cached.
 */
export async function findTranscriptSessionIds({
  roots,
}: {
  roots: string[]
}): Promise<Set<string>> {
  const files = await Promise.all(
    roots.map(async root => {
      const projects = await listDir(root)
      const perProject = await Promise.all(projects.map(name => listDir(join(root, name))))

      return perProject.flat()
    }),
  )

  return new Set(
    files
      .flat()
      .filter(file => file.endsWith(TRANSCRIPT_SUFFIX))
      .map(file => file.slice(0, -TRANSCRIPT_SUFFIX.length)),
  )
}
