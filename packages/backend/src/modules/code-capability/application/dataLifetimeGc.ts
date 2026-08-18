// RFC-304 §11.4 (T62) — the hourly sweep that applies the lifetime rules.
//
// The rules in `domain/dataLifetime.ts` are the decision; this is the thing
// that runs them. A retention policy with no sweeper is a policy nobody
// enforces — and the specific consequence here is not slowness, it is that an
// administrator eventually deletes rows by hand and takes the finding ledger
// (and therefore the adoption numbers) with it.
//
// Two properties this sweep must have, both learned from the design's own
// arithmetic of 27,000 rounds per repository per half-year:
//
//   BOUNDED per tick. A first sweep on a database that has never been swept
//   would otherwise try to delete hundreds of thousands of rows in one
//   transaction, hold the write lock through it, and make the platform look
//   hung at exactly the moment somebody first turns the feature on.
//
//   SUMMARISE before discarding, in that order and never the reverse. A crash
//   between the two must leave the aggregate already written — losing detail
//   whose summary exists is a shrug; losing detail whose summary does not is
//   the unrecoverable case.

import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeAiAttempts, codeArtifacts, codeWorkItems, codeWorkRounds } from '@/db/schema'
import {
  ATTEMPT_RETENTION_MS,
  DETAIL_RETENTION_MS,
} from '@/modules/code-capability/domain/dataLifetime'
import { createLogger } from '@/util/log'

const log = createLogger('code-lifetime-gc')

const HOUR_MS = 60 * 60 * 1000

/**
 * Rows touched per tick, per category.
 *
 * Deliberately modest: the sweep runs hourly forever, so it only has to keep up
 * with the inflow, not catch up in one pass. A first run on a long-neglected
 * database converges over days without ever holding the write lock long enough
 * to be noticed.
 */
export const GC_BATCH_LIMIT = 500

export interface LifetimeGcResult {
  attemptsSwept: number
  artifactsReclaimed: number
  roundsSummarised: number
}

export interface LifetimeGcDeps {
  db: DbClient
  now?: () => number
  batchLimit?: number
}

/**
 * One sweep. Safe to call concurrently with ordinary traffic and with itself:
 * every step is a bounded, idempotent delete keyed on a condition that stops
 * being true once applied.
 */
export async function sweepCapabilityData(deps: LifetimeGcDeps): Promise<LifetimeGcResult> {
  const now = (deps.now ?? Date.now)()
  const limit = deps.batchLimit ?? GC_BATCH_LIMIT

  const artifactsReclaimed = await reclaimArtifacts(deps.db, limit)
  const attemptsSwept = await sweepAttempts(deps.db, now - ATTEMPT_RETENTION_MS, limit)
  const roundsSummarised = await countSummarisableRounds(deps.db, now - DETAIL_RETENTION_MS)

  return { attemptsSwept, artifactsReclaimed, roundsSummarised }
}

/**
 * Artifacts nothing references.
 *
 * First, and without an age term: each holds a git ref pinning a commit against
 * `git gc`, so the cost of keeping one is paid in the repository's object store
 * rather than in this database. That makes it the reclamation with the highest
 * value per row and the least reason to wait.
 */
async function reclaimArtifacts(db: DbClient, limit: number): Promise<number> {
  const dead = await db
    .select({ id: codeArtifacts.id })
    .from(codeArtifacts)
    .where(and(eq(codeArtifacts.refCount, 0), isNotNull(codeArtifacts.releasedAt)))
    .limit(limit)
  if (dead.length === 0) return 0

  // RFC-311: one batched DELETE per pass instead of `limit` autocommit
  // statements (the batch is bounded by `limit` ≤ 500, far under the 32766
  // bound-parameter ceiling).
  await db.delete(codeArtifacts).where(
    inArray(
      codeArtifacts.id,
      dead.map((row) => row.id),
    ),
  )
  return dead.length
}

/**
 * Attempt detail past the debugging window.
 *
 * NOT gated on the work item being closed, unlike round detail. Attempts are
 * the fastest-growing table and a long-lived active merge request is exactly
 * where they pile up — gating on `closed` would exempt the worst case.
 */
async function sweepAttempts(db: DbClient, cutoff: number, limit: number): Promise<number> {
  const stale = await db
    .select({ id: codeAiAttempts.id })
    .from(codeAiAttempts)
    .where(lt(codeAiAttempts.startedAt, cutoff))
    .limit(limit)
  if (stale.length === 0) return 0

  await db.delete(codeAiAttempts).where(
    inArray(
      codeAiAttempts.id,
      stale.map((row) => row.id),
    ),
  )
  return stale.length
}

/**
 * How many closed items are old enough to summarise.
 *
 * Counted rather than acted on: writing the rollup needs a destination table
 * that does not exist yet, and deleting the detail BEFORE that table exists
 * would be the exact inversion this module's header warns against. Reporting
 * the number keeps the pressure visible — a figure that climbs is the signal
 * that the rollup is now worth building.
 */
async function countSummarisableRounds(db: DbClient, cutoff: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(codeWorkRounds)
    .innerJoin(codeWorkItems, eq(codeWorkRounds.workItemId, codeWorkItems.id))
    .where(and(eq(codeWorkItems.status, 'closed'), lt(codeWorkRounds.startedAt, cutoff)))
  return row?.n ?? 0
}

/** Hourly ticker, mirroring `startWorktreeGc` / `startBatchImportGc`. */
export function startCapabilityDataGc(
  deps: LifetimeGcDeps,
  intervalMs: number = HOUR_MS,
): { stop: () => void } {
  const handle = setInterval(() => {
    void sweepCapabilityData(deps)
      .then((result) => {
        if (result.attemptsSwept + result.artifactsReclaimed > 0) {
          log.info('swept capability data', { ...result })
        }
      })
      .catch((err: unknown) => {
        // Logged, never thrown: a sweep that fails must not take the daemon
        // with it. The next tick is an hour away and the conditions it keys on
        // are still true, so a transient failure costs one hour of growth.
        log.warn('capability data sweep threw', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, intervalMs)
  handle.unref?.()
  return { stop: () => clearInterval(handle) }
}
