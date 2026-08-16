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
  reclaimStaleLeases,
  releaseLease,
  releaseLeaseOfEndedRound,
  renewLease,
} from '@/modules/code-capability/infrastructure/sqliteMrLeaseStore'
import { createLogger } from '@/util/log'

const log = createLogger('code-round-lease')

/** How long a lease survives without renewal. */
export const ROUND_LEASE_MS = 15 * 60 * 1000

/**
 * How often the holder renews, as a fraction of the lease.
 *
 * A third, not the whole lease: beating exactly at the expiry renews the lease
 * as it dies, so one slow write loses a merge request that was never actually
 * unattended. Two missed beats are survivable; the third is a real stall, and
 * by then the round genuinely should lose its claim.
 */
const RENEW_DIVISOR = 3

/**
 * How the heartbeat is scheduled. Injected so the tests can drive it by hand —
 * a renewal case that depends on wall-clock timing is a flaky case, and this one
 * has to be trustworthy: it is the only thing standing between a long round and
 * a second round on the same merge request.
 */
export interface LeaseTicker {
  /** Run `tick` every `everyMs` until the returned stopper is called. */
  start: (everyMs: number, tick: () => Promise<void>) => () => void
}

const intervalTicker: LeaseTicker = {
  start: (everyMs, tick) => {
    const handle = setInterval(() => {
      void tick()
    }, everyMs)
    // Never a reason to keep the process alive: if the round is gone, so is the
    // reason to renew.
    handle.unref?.()
    return () => {
      clearInterval(handle)
    }
  },
}

export interface RoundLease {
  key: MrLeaseKey
  token: string
  /** Push the expiry out. False once the lease has moved on — token-checked. */
  renew: () => Promise<boolean>
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
  /** Injectable clock; the expiry cases would otherwise be wall-clock races. */
  now?: () => number
}): Promise<RoundLeaseResult> {
  const deps = {
    db: input.db,
    daemonGeneration: input.daemonGeneration,
    leaseMs: input.leaseMs ?? ROUND_LEASE_MS,
    ...(input.now !== undefined ? { now: input.now } : {}),
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
      renew: async () => await renewLease(deps, input.key, token),
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
    now?: () => number
    ticker?: LeaseTicker
  },
  body: (lease: RoundLease) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; heldBy: string }> {
  const acquired = await acquireRoundLease(input)
  if (!acquired.ok) return acquired

  // design §2.2「续租：轮次心跳续租；超时未续 ⇒ 视为失效可被抢」.
  //
  // Without this the lease is not held "for the whole round" as §2.3 claims —
  // it is held for fifteen minutes, and an AI code round routinely runs longer.
  // Past that the expiry branch of `acquireLease` grants, a second round starts
  // on the same merge request, and the interleaving the lease exists to prevent
  // happens on exactly the slow rounds where there is most to interleave.
  const leaseMs = input.leaseMs ?? ROUND_LEASE_MS
  // A beat already in flight when the round ends would otherwise find the row
  // released and report a LOST lease — a false alarm on the one log line an
  // operator is meant to trust.
  let roundOver = false
  const stopHeartbeat = (input.ticker ?? intervalTicker).start(
    Math.max(1, Math.floor(leaseMs / RENEW_DIVISOR)),
    async () => {
      try {
        if (roundOver) return
        const held = await acquired.lease.renew()
        if (!held && !roundOver) {
          // Nothing to do about it from here — the renewal is token-checked, so
          // this round cannot take the merge request back, and it must not try.
          // Logged because a lost lease means a second round may now be writing
          // to the same merge request, which is the one thing an operator
          // reading a confused merge request needs to be able to find out.
          log.warn('round lease lost while the round was still running', {
            roundId: input.roundId,
            anchorId: input.key.anchorId,
            stableProjectId: input.key.stableProjectId,
          })
        }
      } catch (err: unknown) {
        // The beat runs on a timer with nobody to catch it: an unhandled
        // rejection here would take the daemon down over one failed write, and
        // the next beat is a third of a lease away with the lease still valid.
        log.warn('round lease renewal threw', {
          roundId: input.roundId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  try {
    return { ok: true, value: await body(acquired.lease) }
  } finally {
    // Stop BEFORE releasing, so a beat cannot land between the release and the
    // clear and re-extend a lease this round no longer holds.
    roundOver = true
    stopHeartbeat()
    await acquired.lease.release()
  }
}

/**
 * RFC-304 §2.3 崩溃恢复 — drop every lease minted by a previous daemon, at boot.
 *
 * The generation fence already makes those leases takeable, so this is not what
 * keeps a restarted daemon working; it is what keeps the table honest and gives
 * the boot log a number. A row whose owning process is gone is not a claim, and
 * leaving it means `/code` reports a merge request as leased when nothing holds
 * it.
 */
export async function reclaimCodeLeasesOnBoot(
  db: DbClient,
  daemonGeneration: string,
): Promise<number> {
  return await reclaimStaleLeases(db, daemonGeneration)
}
