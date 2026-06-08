import { AppError } from '@personal-automation/common/errors'
import { createAppleTaskSource } from './apple/source.js'
import { createObsidianTaskSource } from './obsidian/source.js'
import type { TaskSource } from './types.js'

// The set of task backends the digest can read from. `apple` (EventKit/Reminders, macOS-only) and
// `obsidian` (Markdown todos in a vault on disk) are implemented; `google` is a planned drop-in
// (Google Tasks). Keeping this as a const array lets config.ts validate TASK_PROVIDER against it
// without the two drifting apart.
export const TASK_PROVIDERS = ['apple', 'google', 'obsidian'] as const
export type TaskProvider = (typeof TASK_PROVIDERS)[number]

// The single switch point between providers. Selecting a backend is a config change
// (TASK_PROVIDER), not a code change. Provider-specific config (vaultPath) is validated here
// rather than as an always-required env var, so an apple setup needn't carry an Obsidian path.
export function createTaskSource({
  provider,
  lists,
  vaultPath,
}: {
  provider: TaskProvider
  lists: readonly string[]
  vaultPath?: string
}): TaskSource {
  switch (provider) {
    case 'apple':
      return createAppleTaskSource({ lists })
    case 'obsidian':
      if (!vaultPath) {
        throw new AppError({
          message: 'TASK_PROVIDER=obsidian requires OBSIDIAN_VAULT_PATH to point at your vault.',
        })
      }

      return createObsidianTaskSource({ vaultPath, lists })
    case 'google':
      throw new AppError({
        message:
          'TASK_PROVIDER=google is not implemented yet. Implement createGoogleTaskSource under apps/stalled-tasks/src/tasks/google/ and wire it here, or set TASK_PROVIDER=apple.',
      })
    default: {
      const _exhaustive: never = provider
      throw new AppError({ message: `Unknown task provider: ${String(_exhaustive)}` })
    }
  }
}
