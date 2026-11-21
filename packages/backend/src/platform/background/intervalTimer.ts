// RFC-529 — the one fixed-rate timer a business module starts: a named owner and an explicit stop. It is
// `setInterval` / `clearInterval` with the same semantics (fixed rate; the global timer is read at each start, so test
// doubles of the global timers keep working). The owner names the module and purpose; it is not registered anywhere.

export interface IntervalTimer {
  /** The module and purpose that started the timer, e.g. `integration.mr-terminal-control`. */
  readonly owner: string
  /** Stop the timer; calling it again does nothing. */
  stop(): void
  /** Let the process exit while the timer is armed (a no-op where the handle has no `unref`). */
  unref(): void
}

export function startInterval(input: {
  readonly owner: string
  readonly everyMs: number
  readonly tick: () => void
}): IntervalTimer {
  let handle: ReturnType<typeof setInterval> | null = setInterval(input.tick, input.everyMs)
  return Object.freeze({
    owner: input.owner,
    stop() {
      if (handle === null) return
      clearInterval(handle)
      handle = null
    },
    unref() {
      ;(handle as { unref?: () => void } | null)?.unref?.()
    },
  })
}
