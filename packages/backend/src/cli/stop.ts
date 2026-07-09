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
    let shutdownInitiated = false
    if (info && token) {
      try {
        const res = await fetch(`${info.url}api/shutdown?token=${token}`, {
          method: 'POST',
        })
        if (res.ok) {
          shutdownInitiated = true
        }
        // Non-OK (e.g. 503 shutdown-not-wired on a daemon that predates the
        // route) → leave shutdownInitiated false; hard-kill fallback below.
      } catch {
        // The route handler is fire-and-forget: it calls deps.shutdown() and
        // returns, and the daemon tears its listening socket down as it exits.
        // That closes the connection mid-response, so fetch throws even though
        // the POST reached the handler and a graceful shutdown is in flight.
        // Treat the throw as "shutdown initiated" — do NOT fall through to
        // the hard-kill, which would TerminateProcess the daemon mid-shutdown,
        // racing the exit handler that unlinks the lock (and leave it behind).
        shutdownInitiated = true
      }
    }
    if (shutdownInitiated) {
      return await waitForExit(lockPath, pid, opts.timeoutMs)
    }
    // Fallback: hard-kill the pid (last resort; matches the pre-RFC behaviour).
    // TerminateProcess bypasses the exit handler, so the lock + info file would
    // be left behind; waitForExit reaps them once the process is gone.
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

/** Poll for the lock file to vanish (daemon exited). Shared by both branches.
 *  Also reaps a stale lock + info file if the process has died without removing
 *  them (e.g. a Windows hard-kill TerminateProcess bypasses the exit handler) -
 *  the daemon is gone, so the lock is definitively stale. RFC-W001. */
async function waitForExit(lockPath: string, pid: number, timeoutMs?: number): Promise<StopResult> {
  const deadline = Date.now() + (timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) {
      return { status: 'stopped', pid, message: `daemon (PID ${pid}) stopped` }
    }
    if (!isProcessAlive(pid)) {
      // Process is gone but left the lock behind - reap it.
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
