import { createJsonFile } from './json-file.js'
import { metadataFileSchema } from './schemas.js'
import type { MetadataBySession, MetadataPatch, SessionMetadata } from './types.js'

export interface MetadataStore {
  read(): Promise<MetadataBySession>
  patch(input: { sessionId: string; changes: MetadataPatch }): Promise<SessionMetadata>
  /**
   * Take a row off the board, keeping the name and dropping the rest.
   *
   * The name is what says which session a drawer row is, so wiping it left
   * sixteen rows reading "unnamed" beside a path. Everything else is where the
   * row sat and what you were waiting on, which is exactly what taking it off
   * the board says you are done with.
   */
  dismiss(sessionId: string): Promise<void>
  remove(sessionId: string): Promise<void>
  /** Several rows' changes in one write. */
  patchMany(patches: { sessionId: string; changes: MetadataPatch }[]): Promise<void>
  /**
   * Apply `changes` and move the row into its group just above `before`, or
   * last when `before` is undefined or not in that group. Every row on the
   * board in that group is renumbered from 0, in the same write.
   */
  place(input: {
    sessionId: string
    changes: MetadataPatch
    before: string | undefined
  }): Promise<SessionMetadata>
}

function byOrder(a: SessionMetadata, b: SessionMetadata): number {
  return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
}

function withoutEmptyFields(metadata: SessionMetadata): SessionMetadata {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined)

  return Object.fromEntries(entries)
}

export function createMetadataStore({ path }: { path: string }): MetadataStore {
  const { read, write, serialize } = createJsonFile({
    path,
    schema: metadataFileSchema,
    empty: {},
  })

  function patch({
    sessionId,
    changes,
  }: {
    sessionId: string
    changes: MetadataPatch
  }): Promise<SessionMetadata> {
    return serialize(async () => {
      // Re-read rather than caching: the file is small, and it is meant to be
      // hand-editable, so an edit made outside the app must not be clobbered.
      const all = await read()
      const merged = withoutEmptyFields({ ...all[sessionId], ...changes })

      await write({ ...all, [sessionId]: merged })

      return merged
    })
  }

  function dismiss(sessionId: string): Promise<void> {
    return serialize(async () => {
      const all = await read()
      const { name } = all[sessionId] ?? {}

      await write({ ...all, [sessionId]: withoutEmptyFields({ name, isDismissed: true }) })
    })
  }

  function remove(sessionId: string): Promise<void> {
    return serialize(async () => {
      const all = await read()
      if (!(sessionId in all)) return

      const { [sessionId]: _removed, ...rest } = all

      await write(rest)
    })
  }

  function patchMany(patches: { sessionId: string; changes: MetadataPatch }[]): Promise<void> {
    return serialize(async () => {
      const all = await read()
      for (const { sessionId, changes } of patches) {
        all[sessionId] = withoutEmptyFields({ ...all[sessionId], ...changes })
      }

      await write(all)
    })
  }

  function place({
    sessionId,
    changes,
    before,
  }: {
    sessionId: string
    changes: MetadataPatch
    before: string | undefined
  }): Promise<SessionMetadata> {
    return serialize(async () => {
      const all = await read()
      const moved = withoutEmptyFields({ ...all[sessionId], ...changes })

      const others = Object.entries(all)
        .filter(
          ([id, entry]) =>
            id !== sessionId &&
            entry.group === moved.group &&
            !entry.isDismissed &&
            !entry.supersededBy,
        )
        .sort(([, a], [, b]) => byOrder(a, b))
        .map(([id]) => id)

      const at = before === undefined ? -1 : others.indexOf(before)
      const placed = [...others]
      placed.splice(at === -1 ? others.length : at, 0, sessionId)

      all[sessionId] = moved
      placed.forEach((id, order) => {
        all[id] = { ...all[id], order }
      })
      await write(all)

      return all[sessionId] ?? moved
    })
  }

  return { read, patch, dismiss, remove, patchMany, place }
}
