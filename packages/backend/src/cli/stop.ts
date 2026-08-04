// `agent-workflow stop` — ask the daemon to drain, wait for it to exit (lock
// file unlinked), or time out.
//
// RFC-254 T7 — HOW THE REQUEST IS SENT DEPENDS ON THE PLATFORM.
//
// POSIX sends SIGTERM, which `cli/start.ts` handles by running
// `gracefulShutdown(db, 30_000)`. That path is unchanged.
//
// Windows has no SIGTERM. `process.kill(pid, 'SIGTERM')` does not throw there
// — it maps to `TerminateProcess`, the same hard kill as SIGKILL — so the old
// code silently killed the daemon mid-write and still printed "stopped": no
// drain, no task bookkeeping, and `interrupted` rows for the next start to
// reap. Windows therefore POSTs to the loopback control listener instead, and
// only falls back to a hard kill when that request cannot be delivered — in
// which case it says so, rather than reporting a graceful stop it did not do.

import { existsSync, unlinkSync } from 'node:fs'
import {
  hardKill,
  readControlFile,
  removeControlFile,
  requestShutdown,
} from '@/services/controlListener'
import { isProcessAlive, readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface StopOptions {
  /** Max time to wait for the daemon to exit after the request. Default 30s. */
  timeoutMs?: number
  /** Injected for tests; defaults to the real platform. */
  platform?: NodeJS.Platform
}

export interface StopResult {
  status: 'stopped' | 'not-running' | 'stale-lock-removed' | 'timeout' | 'forced'
  pid?: number
  message: string
  /**
   * Whether the daemon was ASKED to drain (versus killed outright). `false`
   * means in-flight work was not parked and the next start will have rows to
   * reap — the caller must not describe that as a clean stop.
   */
  graceful?: boolean
}

export async function stopCommand(opts: StopOptions = {}): Promise<StopResult> {
  const platform = opts.platform ?? process.platform
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
    removeControlFile(Paths.controlFile)
    return {
      status: 'stale-lock-removed',
      pid,
      message: `lock for PID ${pid} was stale (process not alive); removed`,
    }
  }

  const requested = await requestDrain(pid, platform)
  if (requested.kind === 'failed') {
    throw new Error(`failed to signal PID ${pid}: ${requested.reason}`)
  }

  const timeoutMs = opts.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) {
      return {
        status: 'stopped',
        pid,
        graceful: true,
        message: `daemon (PID ${pid}) stopped`,
      }
    }
    await Bun.sleep(100)
  }

  // The drain did not finish in time. On Windows there is one more thing to
  // try, and the result must be labelled honestly either way.
  if (platform === 'win32' && hardKill(pid, platform)) {
    removeControlFile(Paths.controlFile)
    return {
      status: 'forced',
      pid,
      graceful: false,
      message:
        `daemon (PID ${pid}) did not drain within ${timeoutMs}ms and was terminated. ` +
        `This was NOT a graceful shutdown: in-flight tasks were not parked and the ` +
        `next start will reap them as interrupted.`,
    }
  }
  return {
    status: 'timeout',
    pid,
    graceful: false,
    message: `daemon (PID ${pid}) did not exit within ${timeoutMs}ms`,
  }
}

/**
 * Deliver the "please drain" request by whichever mechanism this platform has.
 *
 * The two are not interchangeable, and the difference is the whole point of
 * T7 — see the file header.
 */
async function requestDrain(
  pid: number,
  platform: NodeJS.Platform,
): Promise<{ kind: 'sent' } | { kind: 'failed'; reason: string }> {
  if (platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM')
      return { kind: 'sent' }
    } catch (err) {
      return { kind: 'failed', reason: (err as Error).message }
    }
  }

  const endpoint = readControlFile(Paths.controlFile)
  if (endpoint === null) {
    return {
      kind: 'failed',
      reason:
        `no control endpoint at ${Paths.controlFile}. Windows has no SIGTERM, so a ` +
        `graceful stop needs the daemon's loopback listener; a daemon started before ` +
        `this was added, or one whose control file was removed, can only be killed.`,
    }
  }
  if (endpoint.pid !== pid) {
    return {
      kind: 'failed',
      reason:
        `control file names PID ${endpoint.pid} but the lock names ${pid}; refusing to ` +
        `send a shutdown to a daemon that may not be the one holding the lock`,
    }
  }
  const outcome = await requestShutdown(endpoint)
  if (outcome === 'accepted') return { kind: 'sent' }
  return {
    kind: 'failed',
    reason:
      outcome === 'unauthorized'
        ? 'the control nonce was refused (stale control file from a previous daemon)'
        : 'the control listener did not answer',
  }
}
