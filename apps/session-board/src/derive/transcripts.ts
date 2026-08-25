import { readdir, stat } from 'node:fs/promises'
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

async function writtenAt(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)

    return Math.floor(info.mtimeMs / 1000)
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    // Deleted between the listing and the stat.
    if (code === 'ENOENT') return undefined

    throw error
  }
}

/**
 * Every session Claude Code still holds a transcript for, and when each was
 * last written to.
 *
 * Found by listing the project directories rather than by working out where a
 * given session's transcript ought to be. Claude Code names a project directory
 * after the directory the session *started* in, and a session that moves (a
 * `cd`, or a subagent working in a scratchpad) keeps its transcript where it
 * began. Nine of twenty-six real sessions had moved, so a path built from the
 * directory a session last reported would have called a third of the board
 * unresumable.
 *
 * The write time is what tells a session working through a long turn from one
 * stopped at a permission prompt, which fire the same hook events. Listing and
 * statting 317 transcripts across 51 project directories costs 1.3ms warm and
 * 5.4ms cold, which is why it runs per snapshot rather than being cached.
 */
export async function findTranscripts({
  roots,
}: {
  roots: string[]
}): Promise<Map<string, number>> {
  const times = new Map<string, number>()

  await Promise.all(
    roots.map(async root => {
      const projects = await listDir(root)

      await Promise.all(
        projects.map(async project => {
          const directory = join(root, project)
          const files = await listDir(directory)

          await Promise.all(
            files
              .filter(file => file.endsWith(TRANSCRIPT_SUFFIX))
              .map(async file => {
                const at = await writtenAt(join(directory, file))
                if (at !== undefined) times.set(file.slice(0, -TRANSCRIPT_SUFFIX.length), at)
              }),
          )
        }),
      )
    }),
  )

  return times
}
