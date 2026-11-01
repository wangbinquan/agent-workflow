import { isDaemonInterruptionAbortReason } from '@agent-workflow/shared'

/** RFC-243 §4.5 — the call row's human-wait ledger is observed at this granularity. */
export const CALL_CHILD_OBSERVE_MS = 5_000

/** Bounded wait proving a child's daemon-restart interrupt is this process going down. */
export const SHUTDOWN_CONFIRM_MS = 2_000

export function isShutdownAbort(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || !signal.aborted) return false
  return isDaemonInterruptionAbortReason(signal.reason)
}

/**
 * RFC-243 实现门 P1-5 — confirm that a child's `daemon-restart` interrupt is
 * THIS daemon going down, by waiting (bounded) for the parent's own shutdown
 * abort. The child's abort routinely lands first (abortAllActiveTasks iterates
 * one map), so an instantaneous `signal.aborted` check is not a discriminator.
 * Confirmed ⇒ the caller yields without writing a terminal row and the
 * parent's ordinary shutdown path (`cancelTaskRow`) records `interrupted`,
 * keeping the whole tree resumable. NOT confirmed (e.g. a stale interrupt
 * inherited from a previous crash that resume could not clear) ⇒ the caller
 * keeps its genuine `child-interrupted` failure.
 */
export async function awaitShutdownAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (signal === undefined) return false
  if (signal.aborted) return isDaemonInterruptionAbortReason(signal.reason)
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(isDaemonInterruptionAbortReason(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
