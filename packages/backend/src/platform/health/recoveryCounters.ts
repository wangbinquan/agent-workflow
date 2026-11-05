// RFC-108 T3 (AR-11) — in-process "since boot" counters of system recovery
// actions, reported by `/health` (`recovery` field).
//
// Single-daemon seam: the persistent recovery_events table is the durable
// history; these are a cheap health gauge that resets on restart by design.
//
// RFC-445: moved out of services/recovery.ts. Four sites bump it — platform's
// SQLite restore, System Operations' resource-limit cancellation, Task
// Execution's idle reap and the recovery audit (`recordRecoveryEvent`) — and
// platform cannot import a module, so the gauge lives in platform beside the
// health probe that reads it.

const counters = new Map<string, number>()

export function bumpRecoveryCounter(key: string, by = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + by)
}

export function recoveryCountersSnapshot(): Record<string, number> {
  return Object.fromEntries(counters)
}

/** Test helper — clear the in-process counters between cases. */
export function __resetRecoveryCountersForTest(): void {
  counters.clear()
}
