// RFC-108 T12 (AR-08) — driver lease.
//
// A task's "live state" (its worktree, its node_run rows, its running child) may
// be mutated by at most ONE driver at a time. Today that's an informal
// convention enforced ad-hoc via `isTaskActive`/scheduler ownership; once the
// auto loops (boot auto-resume, auto-repair, heartbeat-kill) land they become a
// SECOND class of driver that can collide with a human's resume/retry/repair on
// the same task. This is the explicit seam: an auto-actor must hold the lease
// before touching live state and release it after, so two auto-actors — or an
// auto-actor and a human — never git-reset / re-mint the same task concurrently.
//
// v1 is in-process (single daemon — the lease Map starts empty at boot, so there
// is nothing stale to clear). The interface is intentionally DB-swappable: a
// future multi-daemon build replaces the Map with a `recovery_leases` table +
// TTL without changing callers. `touchesLiveState` marks the recovery operations
// that MUST run under a lease.

export type LiveStateOp = 'auto-resume' | 'auto-repair' | 'heartbeat-kill' | 'periodic-reconcile'

interface Lease {
  holder: string
  acquiredAt: number
}

const leases = new Map<string, Lease>()

/**
 * Acquire the lease for `taskId`. Returns true if the caller now holds it (it was
 * free, or already held by this same holder — re-entrant). Returns false if a
 * DIFFERENT holder owns it.
 */
export function acquireDriverLease(
  taskId: string,
  holder: string,
  now: number = Date.now(),
): boolean {
  const existing = leases.get(taskId)
  if (existing !== undefined && existing.holder !== holder) return false
  leases.set(taskId, { holder, acquiredAt: now })
  return true
}

/** Release the lease IFF held by `holder` (a no-op otherwise — never steal). */
export function releaseDriverLease(taskId: string, holder: string): void {
  if (leases.get(taskId)?.holder === holder) leases.delete(taskId)
}

/** Is any driver currently holding the lease for this task? */
export function isDriverLeaseHeld(taskId: string): boolean {
  return leases.has(taskId)
}

/** The current holder, or null. */
export function driverLeaseHolder(taskId: string): string | null {
  return leases.get(taskId)?.holder ?? null
}

/**
 * Run `fn` while holding the lease, releasing it afterward (even on throw).
 * Returns `fn`'s result, or `null` WITHOUT running it when a different holder
 * already owns the lease — the canonical guard for every `touchesLiveState`
 * recovery op. The op name is informational (telemetry / future DB rows).
 */
export async function withDriverLease<T>(
  taskId: string,
  holder: string,
  _op: LiveStateOp,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!acquireDriverLease(taskId, holder)) return null
  try {
    return await fn()
  } finally {
    releaseDriverLease(taskId, holder)
  }
}

/** Test helper — clear all leases between cases. */
export function __clearDriverLeasesForTest(): void {
  leases.clear()
}
