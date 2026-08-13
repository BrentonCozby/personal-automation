import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type LockHandle = { release: () => void; path: string }

export class LockHeldError extends Error {
  override readonly name = 'LockHeldError'
  readonly heldByPid: number
  readonly path: string

  constructor({ path, heldByPid }: { path: string; heldByPid: number }) {
    super(`Lock held by PID ${heldByPid} at ${path}`)
    this.path = path
    this.heldByPid = heldByPid
  }
}

// A dead PID in the lockfile means a previous run crashed without cleaning up, so we claim it.
export function acquireLock(path: string): LockHandle {
  if (existsSync(path)) {
    const heldByPid = readPidFromLock(path)
    if (heldByPid !== null && isProcessRunning(heldByPid)) {
      throw new LockHeldError({ path, heldByPid })
    }
  }
  writeFileSync(path, String(process.pid))
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }

  return { release, path }
}

function readPidFromLock(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())

    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 doesn't deliver anything; it just probes whether the PID is reachable.
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}
