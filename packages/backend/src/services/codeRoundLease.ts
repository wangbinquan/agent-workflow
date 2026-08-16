// RFC-304 §2.3 — holding the MR lease for the duration of a round.
//
// `mr-review` and `mr-monitor` are two work items, and both can legitimately be
// running. The design records exactly what goes wrong without a lease above
// them: an MR update and a pipeline failure arrive together, the monitor starts
// fixing CI and pushes, and the review round — still working from the OLD sha —
// posts remarks on code the machine has already changed. The author reads
// comments about lines that no longer exist.
//
// So the lease is keyed by the MR, not by the capability, and it is held for
// the WHOLE round rather than only around publishing. "Review is independent of
// the monitor" (proposal E1) means their entry points are independent; it does
// not make them independent concurrency domains.
//
// ## What this module deliberately does not do
//
// It does not queue. A round that cannot take the lease is simply not started,
// and the delivery that would have started it is recorded as skipped — the
// design's queue-and-merge behaviour (keep only the newest `pendingRevision`,
// bump the epoch) belongs to the work item, which is a later PR. Starting a
// round anyway would produce exactly the interleaving the lease exists to stop,
// so refusing is the safe half to build first.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeWorkRounds } from '@/db/schema'
import type { MrLeaseKey } from '@/modules/code-capability/domain/mrLease'
import { mintLeaseToken } from '@/modules/code-capability/domain/mrLease'
import {
  acquireLease,
  releaseLease,
  releaseLeaseOfEndedRound,
} from '@/modules/code-capability/infrastructure/sqliteMrLeaseStore'

/** How long a lease survives without renewal. */
export const ROUND_LEASE_MS = 15 * 60 * 1000

export interface RoundLease {
  key: MrLeaseKey
  token: string
  /** Release is idempotent and token-checked; safe to call more than once. */
  release: () => Promise<void>
}

export type RoundLeaseResult =
  | { ok: true; lease: RoundLease }
  /** Someone else holds this MR. The round must not start. */
  | { ok: false; heldBy: string }

/** Whether the round holding a lease has already recorded its terminal answer. */
async function holderRoundHasEnded(db: DbClient, roundId: string): Promise<boolean> {
  const [row] = await db
    .select({ endedAt: codeWorkRounds.endedAt })
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.id, roundId))
    .limit(1)
  // An unknown round is treated as alive: better a round that waits than one
  // that steals a lease from a holder this process cannot see.
  return row !== undefined && row.endedAt !== null
}

/**
 * Take the MR lease for a round, or report who holds it.
 *
 * `daemonGeneration` fences a crash: a token minted by a previous daemon is
 * void, so a machine that died holding leases does not lock every MR it touched
 * until each one expires.
 */
export async function acquireRoundLease(input: {
  db: DbClient
  daemonGeneration: string
  key: MrLeaseKey
  roundId: string
  leaseMs?: number
}): Promise<RoundLeaseResult> {
  const deps = {
    db: input.db,
    daemonGeneration: input.daemonGeneration,
    leaseMs: input.leaseMs ?? ROUND_LEASE_MS,
  }
  const token = mintLeaseToken(input.daemonGeneration, ulid())
  let outcome = await acquireLease(deps, input.key, input.roundId, token)

  if (outcome.outcome === 'busy') {
    // Is the holder actually alive? The ordinary release runs in a `finally`,
    // which a hard-killed task never reaches — so a preempted round holds its
    // merge request for the lease's full lifetime and the replacement round
    // dies at the door with "another round holds this merge request". Nothing
    // says so on the merge request, and fifteen minutes later the lease expires
    // and the whole thing looks like it simply took a while.
    //
    // A round that has ENDED cannot be writing, so its lease is a leak rather
    // than a claim. Reclaimed by round id (not by expiry) so the recovery is
    // immediate and provable, and only for the round the ledger says is over.
    if (await holderRoundHasEnded(input.db, outcome.heldBy)) {
      await releaseLeaseOfEndedRound(input.db, input.key, outcome.heldBy)
      outcome = await acquireLease(deps, input.key, input.roundId, token)
    }
  }

  if (outcome.outcome === 'busy') {
    return { ok: false, heldBy: outcome.heldBy }
  }

  return {
    ok: true,
    lease: {
      key: input.key,
      token,
      release: async () => {
        // Token-checked inside the store: a round whose lease was reclaimed
        // while it ran must NOT release the new holder's lease on its way out.
        await releaseLease(input.db, input.key, token)
      },
    },
  }
}

/**
 * Run `body` holding the MR lease, releasing on every exit path.
 *
 * The release is in a `finally` because the design releases on ANY terminal
 * state — settled, failed, cancelled — and a leaked lease is worse than a
 * failed round: it silently blocks every capability on that MR until it
 * expires, and nothing in the MR says why nothing is happening.
 */
export async function withRoundLease<T>(
  input: {
    db: DbClient
    daemonGeneration: string
    key: MrLeaseKey
    roundId: string
    leaseMs?: number
  },
  body: (lease: RoundLease) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; heldBy: string }> {
  const acquired = await acquireRoundLease(input)
  if (!acquired.ok) return acquired
  try {
    return { ok: true, value: await body(acquired.lease) }
  } finally {
    await acquired.lease.release()
  }
}
