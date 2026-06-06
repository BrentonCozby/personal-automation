import { formatError } from './errors.js'
import { acquireLock, type LockHandle, LockHeldError } from './lock.js'

/**
 * Acquires a PID lockfile, wires SIGINT/SIGTERM cleanup so a Ctrl-C or launchd kill doesn't leave
 * a stale lock, runs `run`, and releases on exit. Exits 2 if another run already holds the lock.
 * Shared by the scheduled CLIs so the lock/signal dance lives in one place.
 */
export async function runWithLock({
  lockPath,
  run,
}: {
  lockPath: string
  run: () => Promise<void>
}): Promise<void> {
  let lock: LockHandle
  try {
    lock = acquireLock(lockPath)
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`[FATAL] ${err.message}. Another run is in progress; exiting.`)
      process.exit(2)
    }
    throw err
  }

  const cleanupAndExit = (signalExitCode: number): void => {
    lock.release()
    process.exit(signalExitCode)
  }
  process.on('SIGINT', () => cleanupAndExit(130))
  process.on('SIGTERM', () => cleanupAndExit(143))

  try {
    await run()
  } finally {
    lock.release()
  }
}

/** Top-level rejection handler for a CLI's `main()`: print the error and exit non-zero. */
export function fatal(err: unknown): never {
  console.error('[FATAL]', formatError(err))
  process.exit(1)
}
