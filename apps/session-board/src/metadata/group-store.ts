import { createJsonFile } from './json-file.js'
import { groupsFileSchema } from './schemas.js'

export interface GroupStore {
  read(): Promise<string[]>
  /** False when the name is already a group, which the caller answers with 409. */
  add(name: string): Promise<boolean>
  rename(input: { from: string; to: string }): Promise<void>
  remove(name: string): Promise<void>
  /** Take in names seen on rows, and answer with the ones that were new. */
  register(names: string[]): Promise<string[]>
  /**
   * Move a group just above `before`, or last when `before` is undefined or not
   * a group. False when `name` is not a group.
   */
  move(input: { name: string; before: string | undefined }): Promise<boolean>
}

/**
 * The groups the board draws, including the ones holding no sessions.
 *
 * A group used to be nothing but the name written on its rows, so taking the
 * last session out of one deleted it. This file is what lets a group outlive
 * its rows and be deleted on purpose instead.
 */
export function createGroupStore({ path }: { path: string }): GroupStore {
  const { read, write, serialize } = createJsonFile({
    path,
    schema: groupsFileSchema,
    empty: [],
  })

  function add(name: string): Promise<boolean> {
    return serialize(async () => {
      const groups = await read()
      if (groups.includes(name)) return false

      await write([...groups, name])

      return true
    })
  }

  function rename({ from, to }: { from: string; to: string }): Promise<void> {
    return serialize(async () => {
      const groups = await read()
      if (!groups.includes(from)) return

      // Mapped in place rather than removed and appended, so a rename does not
      // reorder the file under someone reading it by hand. Renaming onto a name
      // that is already a group merges the two, so the result is deduplicated.
      await write([...new Set(groups.map(name => (name === from ? to : name)))])
    })
  }

  function remove(name: string): Promise<void> {
    return serialize(async () => {
      const groups = await read()
      if (!groups.includes(name)) return

      await write(groups.filter(group => group !== name))
    })
  }

  function register(names: string[]): Promise<string[]> {
    return serialize(async () => {
      const groups = await read()
      const missing = [...new Set(names)].filter(name => !groups.includes(name))
      // A snapshot calls this, and every write wakes the watcher that asks for
      // the next snapshot, so writing when nothing is new would never settle.
      if (missing.length === 0) return []

      await write([...groups, ...missing])

      return missing
    })
  }

  function move({ name, before }: { name: string; before: string | undefined }): Promise<boolean> {
    return serialize(async () => {
      const groups = await read()
      if (!groups.includes(name)) return false

      const others = groups.filter(group => group !== name)
      const at = before === undefined ? -1 : others.indexOf(before)
      others.splice(at === -1 ? others.length : at, 0, name)
      await write(others)

      return true
    })
  }

  return { read, add, rename, remove, register, move }
}
