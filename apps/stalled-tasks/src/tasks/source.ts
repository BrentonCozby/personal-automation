import { AppError } from '@personal-automation/common/errors'
import { createAppleTaskSource } from './apple/source.js'
import type { TaskSource } from './types.js'

// The set of task backends the digest can read from. `apple` (EventKit/Reminders) is the only
// one implemented today; `google` is the planned drop-in (Google Tasks). Keeping this as a const
// array lets config.ts validate TASK_PROVIDER against it without the two drifting apart.
export const TASK_PROVIDERS = ['apple', 'google'] as const
export type TaskProvider = (typeof TASK_PROVIDERS)[number]

// The single switch point between providers. Selecting a backend is a config change
// (TASK_PROVIDER), not a code change — so moving off macOS becomes "set the env var" once a
// non-Apple provider exists.
export function createTaskSource({
  provider,
  lists,
}: {
  provider: TaskProvider
  lists: readonly string[]
}): TaskSource {
  switch (provider) {
    case 'apple':
      return createAppleTaskSource({ lists })
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
