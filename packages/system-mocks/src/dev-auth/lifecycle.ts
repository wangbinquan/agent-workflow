// Orphan detection for the dev auth process.
//
// `bun run --filter '*' dev` puts the daemon, vite and this service in one
// process group, so a terminal Ctrl-C (group SIGINT) reaches all three and this
// one shuts down with them — measured, not assumed. What does NOT reach it is
// the parent dying without passing anything on: `kill -9` on the filter runner,
// a crashed parent, a closed terminal on some setups. The child is then
// reparented to pid 1 and keeps holding the login port, so the next `bun dev`
// meets EADDRINUSE from a process nobody remembers starting.
//
// Both orphan signals are polled because they answer slightly different
// questions and both are cheap: the parent pid CHANGING (reparented) and the
// original parent no longer EXISTING (gone, whatever we were reparented to).
// Bun reports both — verified on bun 1.3.13: after `kill -9` on the parent,
// `process.ppid` reads 1 and `process.kill(originalPpid, 0)` throws ESRCH.

export interface OrphanWatchdogOptions {
  /** Parent pid captured at startup. */
  readonly parentPid: number
  /** Reads the CURRENT parent pid (process.ppid in production). */
  readonly currentParentPid: () => number
  /** Whether a pid still exists (signal-0 probe in production). */
  readonly isAlive: (pid: number) => boolean
  readonly onOrphaned: (reason: string) => void
  readonly intervalMs?: number
  /** Injected for tests; defaults to the global timer. */
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export const ORPHAN_WATCHDOG_INTERVAL_MS = 2000

/**
 * Returns a stop function. A process whose parent is ALREADY pid 1 at startup
 * (nohup, launchd, a container init) is deliberately not watched: there is no
 * parent left to outlive, and firing on that would kill every intentionally
 * detached run.
 */
export function startOrphanWatchdog(options: OrphanWatchdogOptions): () => void {
  if (options.parentPid <= 1) return () => undefined
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => {
      const handle = setInterval(callback, ms)
      handle.unref?.()
      return handle
    })
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  let fired = false
  const handle = setTimer(() => {
    if (fired) return
    const reason = orphanReason(options)
    if (reason === null) return
    fired = true
    clearTimer(handle)
    options.onOrphaned(reason)
  }, options.intervalMs ?? ORPHAN_WATCHDOG_INTERVAL_MS)
  return () => clearTimer(handle)
}

function orphanReason(
  options: Pick<OrphanWatchdogOptions, 'parentPid' | 'currentParentPid' | 'isAlive'>,
): string | null {
  const current = options.currentParentPid()
  if (current !== options.parentPid) {
    return `parent ${options.parentPid} is gone (reparented to ${current})`
  }
  if (!options.isAlive(options.parentPid)) return `parent ${options.parentPid} no longer exists`
  return null
}

/** Production probe: signal 0 tells us whether a pid is still around. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
