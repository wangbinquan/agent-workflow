// `agent-workflow stop` — read the lock file, signal the daemon to shut down,
// wait for it to exit (lock file unlinked), or time out.

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { isProcessAlive, readPidFromLock } from '@/util/lock'
import { isWindows } from '@/util/platform'
import { Paths } from '@/util/paths'

export interface StopOptions {
  /** Max time to wait for the daemon to exit after signalling. Default 30s. */
  timeoutMs?: number
}

export interface StopResult {
  status: 'stopped' | 'not-running' | 'stale-lock-removed' | 'timeout'
  pid?: number
  message: string
}

interface DaemonInfo {
  pid: number
  host: string
  port: number
  url: string
  startedAt: string
}

/** Read the daemon's runtime info file; returns undefined if missing/garbled. */
function readDaemonInfo(): DaemonInfo | undefined {
  if (!existsSync(Paths.daemonInfo)) return undefined
  try {
    return JSON.parse(readFileSync(Paths.daemonInfo, 'utf-8')) as DaemonInfo
  } catch {
    return undefined
  }
}

/** Read the daemon token (needed to authenticate the HTTP /api/shutdown call). */
function readDaemonToken(): string | undefined {
  try {
    const t = readFileSync(Paths.tokenFile, 'utf-8').trim()
    return t.length > 0 ? t : undefined
  } catch {
    return undefined
  }
}

export async function stopCommand(opts: StopOptions = {}): Promise<StopResult> {
  const lockPath = Paths.lock
  const pid = readPidFromLock(lockPath)

  if (pid === null) {
    return { status: 'not-running', message: 'no daemon lock found (not running)' }
  }

  if (!isProcessAlive(pid)) {
    try {
      unlinkSync(lockPath)
    } catch {
      /* race; ignore */
    }
    try {
      unlinkSync(Paths.daemonInfo)
    } catch {
      /* may not exist */
    }
    return {
      status: 'stale-lock-removed',
      pid,
      message: `lock for PID ${pid} was stale (process not alive); removed`,
    }
  }

  // RFC-windows PR-1: Windows has no SIGTERM delivery from another process —
  // `process.kill(pid, 'SIGTERM')` is a hard TerminateProcess that bypasses the
  // daemon's graceful-shutdown handler (running tasks would be orphaned, the DB
  // unsynced, the lock left behind). Instead POST the token-gated
  // /api/shutdown route, which fires the same `shutdown()` closure the SIGTERM
  // handler uses on POSIX. Fall back to `process.kill` only if the HTTP path is
  // unreachable (no daemonInfo / no token / network error) so `stop` still
  // works against a daemon that predates the route.
  if (isWindows()) {
    const info = readDaemonInfo()
    const token = readDaemonToken()
    if (info && token) {
      try {
        const res = await fetch(`${info.url}api/shutdown?token=${token}`, {
          method: 'POST',
        })
        if (res.ok) {
          return await waitForExit(lockPath, pid, opts.timeoutMs)
        }
        // Non-OK → fall through to the hard-kill fallback below.
      } catch {
        // Network error / daemon not reachable on the recorded port → fall through.
      }
    }
    // Fallback: hard-kill the pid (last resort; matches the pre-RFC behaviour).
    try {
      process.kill(pid)
    } catch (err) {
      throw new Error(`failed to signal PID ${pid}: ${(err as Error).message}`)
    }
    return await waitForExit(lockPath, pid, opts.timeoutMs)
  }

  // POSIX (byte-for-byte original): SIGTERM the daemon; its handler unlinks
  // the lock + info file and runs gracefulShutdown.
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    throw new Error(`failed to signal PID ${pid}: ${(err as Error).message}`)
  }

  return await waitForExit(lockPath, pid, opts.timeoutMs)
}

/** Poll for the lock file to vanish (daemon exited). Shared by both branches. */
async function waitForExit(lockPath: string, pid: number, timeoutMs?: number): Promise<StopResult> {
  const deadline = Date.now() + (timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) {
      return { status: 'stopped', pid, message: `daemon (PID ${pid}) stopped` }
    }
    await Bun.sleep(100)
  }
  return {
    status: 'timeout',
    pid,
    message: `daemon (PID ${pid}) did not exit within ${timeoutMs ?? 30_000}ms`,
  }
}
