import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLock, LockHeldError } from './lock.js'

const lockPath = (): string =>
  join(tmpdir(), `lock-test-${process.pid}-${Date.now()}-${Math.random()}.lock`)

describe('acquireLock', (): void => {
  let path: string

  beforeEach((): void => {
    path = lockPath()
  })

  afterEach((): void => {
    try {
      // best-effort cleanup
      if (existsSync(path)) writeFileSync(path, '')
    } catch {
      /* noop */
    }
  })

  it('creates the lockfile and writes our PID', (): void => {
    const handle = acquireLock(path)
    try {
      expect(existsSync(path)).toBe(true)
      expect(Number(readFileSync(path, 'utf8'))).toBe(process.pid)
    } finally {
      handle.release()
    }
  })

  it('removes the lockfile on release', (): void => {
    const handle = acquireLock(path)
    handle.release()
    expect(existsSync(path)).toBe(false)
  })

  it('release is idempotent', (): void => {
    const handle = acquireLock(path)
    handle.release()
    expect((): void => handle.release()).not.toThrow()
  })

  it('throws LockHeldError when a live PID owns the lock', (): void => {
    // Write our own PID: process.kill(pid, 0) will succeed because we are alive.
    writeFileSync(path, String(process.pid))
    expect((): unknown => acquireLock(path)).toThrow(LockHeldError)
  })

  it('claims a stale lock when the PID is dead', (): void => {
    // PID 1 (init) is always running, so we need a PID that can't exist.
    // Very large PIDs above OS max are guaranteed-dead.
    writeFileSync(path, '9999999')
    const handle = acquireLock(path)
    try {
      expect(Number(readFileSync(path, 'utf8'))).toBe(process.pid)
    } finally {
      handle.release()
    }
  })

  it('claims a malformed lockfile', (): void => {
    writeFileSync(path, 'not-a-pid')
    const handle = acquireLock(path)
    try {
      expect(Number(readFileSync(path, 'utf8'))).toBe(process.pid)
    } finally {
      handle.release()
    }
  })

  it('LockHeldError carries the PID and path', (): void => {
    writeFileSync(path, String(process.pid))
    try {
      acquireLock(path)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError)
      if (err instanceof LockHeldError) {
        expect(err.heldByPid).toBe(process.pid)
        expect(err.path).toBe(path)
      }
    }
  })
})
