// Single-instance lock for the daemon, per design.md §1.
// Uses an exclusive PID file (O_CREAT | O_EXCL | O_WRONLY) — atomic create,
// readable PID for `agent-workflow stop`, no kernel-level flock dependency
// (cross-platform predictable, sufficient for v1).

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { isProcessAlive } from './process'
import {
  isWindowsCreationTime,
  readWindowsProcessIdentity,
  type WindowsProcessIdentity,
} from './windowsProcessIdentity'

// RFC-098 WP-8: `isProcessAlive` moved to process.ts beside this file (shared with the
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
  /** Real leases compare the complete owner, including same-process adoption generations. */
  isHeld?(): boolean
}

export interface DaemonLockOwner {
  readonly pid: number
  readonly token?: string
  readonly creationTime?: string
}

/** PID-only, partial and future-version records retain their legacy liveness contract. */
export function parseDaemonLockOwner(contents: string): DaemonLockOwner | null {
  const [first, metadata] = contents.trim().split(/\r?\n/)
  const pid = Number.parseInt(first ?? '', 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const legacy = { pid }
  if (!metadata) return legacy
  try {
    const value = JSON.parse(metadata) as {
      version?: unknown
      token?: unknown
      creationTime?: unknown
    }
    if (value.version !== 1 || typeof value.token !== 'string' || !value.token) return legacy
    if (value.creationTime !== undefined && !isWindowsCreationTime(value.creationTime))
      return legacy
    return {
      pid,
      token: value.token,
      ...(value.creationTime === undefined ? {} : { creationTime: value.creationTime as string }),
    }
  } catch {
    return legacy
  }
}

function lockContents(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
}

export function readDaemonLockOwner(lockPath: string): DaemonLockOwner | null {
  const contents = lockContents(lockPath)
  return contents === null ? null : parseDaemonLockOwner(contents)
}

export function sameDaemonLockOwner(a: DaemonLockOwner | null, b: DaemonLockOwner | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.pid === b.pid &&
    a.token === b.token &&
    a.creationTime === b.creationTime
  )
}

export function isDaemonLockOwnerAlive(
  owner: DaemonLockOwner,
  observer: {
    platform: NodeJS.Platform
    alive: (pid: number) => boolean
    identity: (pid: number) => WindowsProcessIdentity
  } = { platform: process.platform, alive: isProcessAlive, identity: readWindowsProcessIdentity },
): boolean {
  if (observer.platform !== 'win32' || owner.creationTime === undefined)
    return observer.alive(owner.pid)
  const identity = observer.identity(owner.pid)
  if (identity.state === 'dead') return false
  if (identity.state === 'unknown') return true
  return identity.creationTime === owner.creationTime
}

/** Action callers must distinguish an exited incarnation from another process reusing its PID. */
export function readLivePidFromLock(lockPath: string): number | null {
  const owner = readDaemonLockOwner(lockPath)
  return owner && isDaemonLockOwnerAlive(owner) ? owner.pid : null
}

export function createCurrentProcessLockOwner(): DaemonLockOwner {
  const identity = process.platform === 'win32' ? readWindowsProcessIdentity(process.pid) : null
  return {
    pid: process.pid,
    token: randomUUID(),
    ...(identity?.state === 'running' ? { creationTime: identity.creationTime } : {}),
  }
}

/** Keep the first line readable by older binaries and PID-only operational tools. */
export function serializeDaemonLockOwner(owner: DaemonLockOwner): string {
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !owner.token ||
    (owner.creationTime !== undefined && !isWindowsCreationTime(owner.creationTime))
  )
    throw new Error('Invalid daemon lock owner')
  return `${owner.pid}\n${JSON.stringify({ version: 1, token: owner.token, ...(owner.creationTime === undefined ? {} : { creationTime: owner.creationTime }) })}\n`
}

function ownedLease(lockPath: string, contents: string): Lock {
  let released = false
  const isHeld = () => !released && lockContents(lockPath) === contents
  return {
    pid: process.pid,
    path: lockPath,
    isHeld,
    release() {
      if (released) return
      const current = isHeld()
      released = true
      if (current) {
        try {
          unlinkSync(lockPath)
        } catch {
          /* Already gone. Comparison is not filesystem CAS. */
        }
      }
    },
  }
}

/**
 * Acquire an exclusive PID-file lock at `lockPath`. Throws DaemonLockHeldError
 * if another live process holds the lock. Reclaims stale locks (PID dead)
 * automatically.
 */
export function acquireLock(lockPath: string): Lock {
  const contents = serializeDaemonLockOwner(createCurrentProcessLockOwner())
  mkdirSync(dirname(lockPath), { recursive: true })

  // Bounded retry loop: at most one stale-lock recovery attempt before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(lockPath, 'wx') // O_WRONLY | O_CREAT | O_EXCL
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'EEXIST') throw err

      const owner = readDaemonLockOwner(lockPath)
      if (owner !== null && isDaemonLockOwnerAlive(owner)) {
        throw new DaemonLockHeldError(owner.pid, lockPath)
      }
      // Stale lock — remove and retry once.
      try {
        unlinkSync(lockPath)
      } catch {
        // race; another acquirer may have just removed it
      }
      continue
    }

    try {
      writeSync(fd, contents)
    } finally {
      closeSync(fd)
    }

    return ownedLease(lockPath, contents)
  }

  // Should never reach here; fail loud if stale-lock recovery races forever.
  throw new Error(`acquireLock: failed to acquire ${lockPath} after retry`)
}

/**
 * Adopt the PID lock across an in-process Bun `--watch` generation restart.
 *
 * Bun tears down the old generation's servers but evaluates the replacement in
 * the same OS process, so the normal process-exit lock cleanup never runs. This
 * helper also completes explicit auto-upgrade takeover. It succeeds only when
 * the file still names this process and has no known conflicting creation identity.
 */
export function adoptCurrentProcessLock(lockPath: string): Lock {
  const previous = lockContents(lockPath)
  const owner = previous === null ? null : parseDaemonLockOwner(previous)
  if (owner?.pid !== process.pid || !isDaemonLockOwnerAlive(owner)) {
    throw new Error(`cannot adopt ${lockPath}: lock is not owned by current process ${process.pid}`)
  }

  const contents = serializeDaemonLockOwner(createCurrentProcessLockOwner())
  const temporary = `${lockPath}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { flag: 'wx' })
    if (lockContents(lockPath) !== previous)
      throw new Error(`cannot adopt ${lockPath}: owner changed`)
    renameSync(temporary, lockPath)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* Renamed or never created. */
    }
  }
  return ownedLease(lockPath, contents)
}

/** Read the daemon PID from a lock file. Returns null if missing/garbled. */
export function readPidFromLock(lockPath: string): number | null {
  return readDaemonLockOwner(lockPath)?.pid ?? null
}

/**
 * Test helper: write an arbitrary PID into a lock file (no atomicity check).
 * Used by tests that need to simulate stale or foreign-owned locks.
 */
export function writePidFileForTest(lockPath: string, pid: number): void {
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, String(pid))
}
