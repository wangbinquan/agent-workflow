// RFC-304 §2.2 invariant two — the lease, made durable.
//
// The decisions all live in `domain/mrLease.ts`; this file's only job is to do
// them atomically. That split matters here more than usual: a lease whose
// "should I grant this" logic is entangled with its SQL is a lease whose
// takeover and restart cases can only be tested by racing real processes.
//
// Every write is a CAS. Reading the row, deciding in application code, then
// writing unconditionally would lose exactly the races the lease exists to
// prevent — two rounds both observing "free" and both writing themselves in.

import { and, eq, lte, or } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeMrLeases } from '@/db/schema'
import {
  decideLeaseAcquisition,
  decideLeaseRelease,
  leaseKeyOf,
  tokenGeneration,
  type LeaseAcquisition,
  type MrLeaseHolder,
  type MrLeaseKey,
} from '@/modules/code-capability/domain/mrLease'

export interface MrLeaseStoreDeps {
  db: DbClient
  /** This daemon's generation; leases minted by an older one are void. */
  daemonGeneration: string
  leaseMs: number
  now?: () => number
}

export async function readLease(db: DbClient, key: MrLeaseKey): Promise<MrLeaseHolder | null> {
  const [row] = await db
    .select()
    .from(codeMrLeases)
    .where(eq(codeMrLeases.leaseKey, leaseKeyOf(key)))
    .limit(1)
  if (row === undefined) return null
  return { roundId: row.holderRoundId, token: row.token, expiresAt: row.expiresAt }
}

/**
 * Try to take the lease for `roundId`.
 *
 * The CAS is expressed in the WHERE clause: the update only lands if the row
 * still looks the way the decision was made against. Losing that race returns
 * `busy`, and the caller stays queued — which is the correct outcome, not an
 * error to retry immediately.
 */
export async function acquireLease(
  deps: MrLeaseStoreDeps,
  key: MrLeaseKey,
  roundId: string,
  token: string,
): Promise<LeaseAcquisition> {
  const now = (deps.now ?? Date.now)()
  const leaseKey = leaseKeyOf(key)
  const current = await readLease(deps.db, key)

  const decision = decideLeaseAcquisition({
    current,
    candidateRoundId: roundId,
    candidateToken: token,
    now,
    leaseMs: deps.leaseMs,
    daemonGeneration: deps.daemonGeneration,
  })
  if (decision.outcome === 'busy') return decision

  if (current === null) {
    try {
      await deps.db.insert(codeMrLeases).values({
        leaseKey,
        holderRoundId: roundId,
        token,
        acquiredAt: now,
        expiresAt: decision.holder.expiresAt,
      })
      return decision
    } catch {
      // Someone inserted between our read and our insert. The primary key made
      // that a loss rather than a duplicate — report busy and let the caller
      // stay queued rather than overwriting the winner.
      const winner = await readLease(deps.db, key)
      return winner === null
        ? decision
        : { outcome: 'busy', heldBy: winner.roundId, expiresAt: winner.expiresAt }
    }
  }

  // Takeover: only if the row still holds the token we decided against, or has
  // since expired. Without the token in the WHERE clause, a lease that changed
  // hands between the read and the write would be silently stolen.
  const updated = await deps.db
    .update(codeMrLeases)
    .set({ holderRoundId: roundId, token, acquiredAt: now, expiresAt: decision.holder.expiresAt })
    .where(
      and(
        eq(codeMrLeases.leaseKey, leaseKey),
        or(eq(codeMrLeases.token, current.token), lte(codeMrLeases.expiresAt, now)),
      ),
    )
    .returning({ leaseKey: codeMrLeases.leaseKey })

  if (updated.length > 0) return decision
  const winner = await readLease(deps.db, key)
  return winner === null
    ? decision
    : { outcome: 'busy', heldBy: winner.roundId, expiresAt: winner.expiresAt }
}

/**
 * Renew, proving holdership with the token.
 *
 * Returns false when the lease has moved on — the caller must then stop
 * writing, because something else now owns this MR.
 */
export async function renewLease(
  deps: MrLeaseStoreDeps,
  key: MrLeaseKey,
  token: string,
): Promise<boolean> {
  const now = (deps.now ?? Date.now)()
  const updated = await deps.db
    .update(codeMrLeases)
    .set({ expiresAt: now + deps.leaseMs })
    .where(and(eq(codeMrLeases.leaseKey, leaseKeyOf(key)), eq(codeMrLeases.token, token)))
    .returning({ leaseKey: codeMrLeases.leaseKey })
  return updated.length > 0
}

/**
 * Drop a lease whose holding round has ENDED.
 *
 * The ordinary release is token-checked and runs in a `finally`, which a task
 * that is hard-killed never reaches — so a preempted round left its merge
 * request locked for the lease's full lifetime (fifteen minutes), and the
 * replacement round the preemption exists to start died immediately with
 * "another round holds this merge request". The author saw nothing at all:
 * one round cancelled, the next refused, and no message on the merge request
 * explaining either.
 *
 * Scoped to the named round so a takeover cannot drop the NEW holder's lease —
 * the same reasoning as the token check, expressed against the one identity the
 * caller can verify is finished.
 */
export async function releaseLeaseOfEndedRound(
  db: DbClient,
  key: MrLeaseKey,
  holderRoundId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(codeMrLeases)
    .where(
      and(
        eq(codeMrLeases.leaseKey, leaseKeyOf(key)),
        eq(codeMrLeases.holderRoundId, holderRoundId),
      ),
    )
    .returning({ leaseKey: codeMrLeases.leaseKey })
  return deleted.length > 0
}

/**
 * Release, proving holdership with the token.
 *
 * Token-checked rather than round-checked: after a takeover the previous round
 * is still shutting down, and releasing by round id would drop the NEW holder's
 * lease — handing the MR to a third round mid-write.
 */
export async function releaseLease(
  db: DbClient,
  key: MrLeaseKey,
  token: string,
): Promise<{ released: boolean; reason?: string }> {
  const current = await readLease(db, key)
  const decision = decideLeaseRelease({ current, token })
  if (decision.outcome === 'not-holder') return { released: false, reason: decision.reason }
  if (current === null) return { released: true }

  await db
    .delete(codeMrLeases)
    .where(and(eq(codeMrLeases.leaseKey, leaseKeyOf(key)), eq(codeMrLeases.token, token)))
  return { released: true }
}

/**
 * Drop every lease minted by a previous daemon generation.
 *
 * Run at boot, before anything tries to acquire. Those processes are gone;
 * nothing will renew or release their leases, and leaving them would block
 * their MRs until the expiry elapsed — with a long lease, for a long time.
 * Returns how many were reclaimed, which is what the boot log reports.
 */
export async function reclaimStaleLeases(db: DbClient, daemonGeneration: string): Promise<number> {
  const rows = await db.select().from(codeMrLeases)
  const stale = rows.filter((r) => tokenGeneration(r.token) !== daemonGeneration)
  for (const row of stale) {
    await db.delete(codeMrLeases).where(eq(codeMrLeases.leaseKey, row.leaseKey))
  }
  return stale.length
}
