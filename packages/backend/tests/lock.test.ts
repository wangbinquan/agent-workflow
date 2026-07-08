import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireLock, DaemonLockHeldError, writePidFileForTest } from '../src/util/lock'

describe('flock (PID-file)', () => {
  let tmp: string
  let lockPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-lock-'))
    lockPath = join(tmp, '.daemon.lock')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('first acquire writes a PID file containing process.pid', () => {
    const lock = acquireLock(lockPath)
    try {
      expect(lock.pid).toBe(process.pid)
      expect(existsSync(lockPath)).toBe(true)
      expect(readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid))
    } finally {
      lock.release()
    }
  })

  test('second acquire on same path throws DaemonLockHeldError with PID', () => {
    const first = acquireLock(lockPath)
    try {
      let caught: unknown
      try {
        acquireLock(lockPath)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(DaemonLockHeldError)
      expect((caught as DaemonLockHeldError).pid).toBe(process.pid)
      expect((caught as DaemonLockHeldError).lockPath).toBe(lockPath)
    } finally {
      first.release()
    }
  })

  test('release is idempotent and unlinks the PID file', () => {
    const lock = acquireLock(lockPath)
    expect(existsSync(lockPath)).toBe(true)
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
    expect(() => lock.release()).not.toThrow()
  })

  test('release does not unlink a foreign-owned lock file', () => {
    // Acquire + release; then someone else writes their PID into the lock file.
    const lock = acquireLock(lockPath)
    lock.release()
    writePidFileForTest(lockPath, 99_999_998)
    // Calling release() again on the original (already-released) lock is no-op
    // and must not nuke the foreign file.
    lock.release()
    expect(existsSync(lockPath)).toBe(true)
  })

  test('stale lock (dead PID) is reclaimed automatically', () => {
    // Pick a PID extremely unlikely to exist on this machine.
    writePidFileForTest(lockPath, 99_999_999)
    const reclaimed = acquireLock(lockPath)
    try {
      expect(reclaimed.pid).toBe(process.pid)
    } finally {
      reclaimed.release()
    }
  })

  test('cross-process: child holding lock blocks parent acquire', async () => {
    const fixturePath = resolve(import.meta.dir, 'fixtures', 'lock-holder.ts')
    // RFC-windows: spawn via process.execPath (the bun binary itself) instead of the
    // bare `bun` command. On Windows `bun` resolves to a `bun.cmd` shim, so
    // `child.pid` would be cmd.exe's pid — different from the bun process that
    // writes its own `process.pid` into the lock file, breaking the assertion
    // below. Using process.execPath directly works identically on POSIX (same
    // binary) and avoids the shim layer on Windows, so child.pid == lock writer.
    const child = Bun.spawn({
      cmd: [process.execPath, fixturePath, lockPath],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      // Wait until child writes "ready" to stdout.
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      const deadline = Date.now() + 5000
      let ready = false
      while (Date.now() < deadline && !ready) {
        const { value, done } = await reader.read()
        if (done) break
        if (decoder.decode(value).includes('ready')) {
          ready = true
          break
        }
      }
      expect(ready).toBe(true)

      // Parent now attempts acquire — must fail with DaemonLockHeldError
      // pointing at the child's PID.
      let caught: unknown
      try {
        acquireLock(lockPath)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(DaemonLockHeldError)
      expect((caught as DaemonLockHeldError).pid).toBe(child.pid)
    } finally {
      child.kill()
      await child.exited
    }

    // After child is killed, the PID file may be left behind (no graceful
    // handler ran). Subsequent acquire should reclaim it.
    const reclaimed = acquireLock(lockPath)
    try {
      expect(reclaimed.pid).toBe(process.pid)
    } finally {
      reclaimed.release()
    }
  })
})
