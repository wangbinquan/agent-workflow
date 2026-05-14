// `agent-workflow stop` — read the lock file, send SIGTERM to the daemon,
// wait for it to exit (lock file unlinked), or time out.

import { existsSync, unlinkSync } from 'node:fs'
import { isProcessAlive, readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface StopOptions {
  /** Max time to wait for the daemon to exit after SIGTERM. Default 30s. */
  timeoutMs?: number
}

export interface StopResult {
  status: 'stopped' | 'not-running' | 'stale-lock-removed' | 'timeout'
  pid?: number
  message: string
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

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    throw new Error(`failed to signal PID ${pid}: ${(err as Error).message}`)
  }

  const timeoutMs = opts.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) {
      return { status: 'stopped', pid, message: `daemon (PID ${pid}) stopped` }
    }
    await Bun.sleep(100)
  }
  return {
    status: 'timeout',
    pid,
    message: `daemon (PID ${pid}) did not exit within ${timeoutMs}ms`,
  }
}
