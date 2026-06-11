// Single-instance lock for the daemon, per design.md §1.
// Uses an exclusive PID file (O_CREAT | O_EXCL | O_WRONLY) — atomic create,
// readable PID for `agent-workflow stop`, no kernel-level flock dependency
// (cross-platform predictable, sufficient for v1).

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { isProcessAlive } from './process'

// RFC-098 WP-8: `isProcessAlive` moved to util/process.ts (shared with the
// services-level pid governance); re-exported here so existing lock callers
// keep their import path.
export { isProcessAlive }

export class DaemonLockHeldError extends Error {
  constructor(
    public readonly pid: number,
    public readonly lockPath: string,
  ) {
    super(`daemon already running (pid ${pid}, lock ${lockPath})`)
    this.name = 'DaemonLockHeldError'
  }
}

export interface Lock {
  readonly pid: number
  readonly path: string
  /** Idempotent. Removes the PID file. Safe to call from exit handlers. */
  release(): void
}

/**
 * Acquire an exclusive PID-file lock at `lockPath`. Throws DaemonLockHeldError
 * if another live process holds the lock. Reclaims stale locks (PID dead)
 * automatically.
 */
export function acquireLock(lockPath: string): Lock {
  mkdirSync(dirname(lockPath), { recursive: true })

  // Bounded retry loop: at most one stale-lock recovery attempt before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(lockPath, 'wx') // O_WRONLY | O_CREAT | O_EXCL
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'EEXIST') throw err

      const stalePid = readPidFromLock(lockPath)
      if (stalePid !== null && isProcessAlive(stalePid)) {
        throw new DaemonLockHeldError(stalePid, lockPath)
      }
      // Stale lock — remove and retry once.
      try {
        unlinkSync(lockPath)
      } catch {
        // race; another acquirer may have just removed it
      }
      continue
    }

    const pid = process.pid
    try {
      writeSync(fd, String(pid))
    } finally {
      closeSync(fd)
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      try {
        const current = readPidFromLock(lockPath)
        if (current === pid) unlinkSync(lockPath)
        // If the PID file no longer matches us, leave it alone — another owner.
      } catch {
        // Lock file gone or unreadable; nothing to do.
      }
    }

    return { release, path: lockPath, pid }
  }

  // Should never reach here; fail loud if stale-lock recovery races forever.
  throw new Error(`acquireLock: failed to acquire ${lockPath} after retry`)
}

/** Read the daemon PID from a lock file. Returns null if missing/garbled. */
export function readPidFromLock(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Test helper: write an arbitrary PID into a lock file (no atomicity check).
 * Used by tests that need to simulate stale or foreign-owned locks.
 */
export function writePidFileForTest(lockPath: string, pid: number): void {
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, String(pid))
}
