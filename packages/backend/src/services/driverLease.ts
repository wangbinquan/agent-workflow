// RFC-108 T12 (AR-08) — retired driver-lease compatibility fixture.
//
// RFC-328 removed every production consumer: durable continuation intents,
// monotonic owner epochs and exact-token resource fences now provide the one
// execution authority for manual and automatic paths. This in-memory Map is
// retained only so RFC-108's historical unit contract remains reproducible;
// production code must not import it, and the RFC-328 architecture guard makes
// any such import fail. It is neither an admission gate nor a fallback.

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
