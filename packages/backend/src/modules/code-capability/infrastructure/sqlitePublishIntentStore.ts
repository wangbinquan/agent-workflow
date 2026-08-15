// RFC-304 §7 — publish intents, made durable.
//
// The ordering here IS the guarantee, so it is worth stating plainly:
//
//   writeIntent()  must complete before the outbound call is made;
//   settleIntent() must complete before the round advances or accepts cancel.
//
// Reversing either one reopens the duplicate-comment window. Writing the intent
// after the call means a crash in between leaves no record that anything was
// sent; settling after advancing means the next stage can observe a round that
// "finished publishing" while its ids are still unwritten.

import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codePublishIntents } from '@/db/schema'
import {
  planPublishRecovery,
  type PublishIntent,
  type PublishRecoveryPlan,
  type RemoteBatchObservation,
} from '@/modules/code-capability/domain/publishIntent'

function rowToIntent(row: typeof codePublishIntents.$inferSelect): PublishIntent {
  return {
    batchId: row.batchId,
    roundId: row.roundId,
    epoch: row.epoch,
    state: row.state,
    fingerprints: JSON.parse(row.fingerprintsJson) as string[],
    externalIds: JSON.parse(row.externalIdsJson) as Record<string, string>,
  }
}

/** Persist the intent. MUST complete before the outbound call. */
export async function writeIntent(
  db: DbClient,
  input: {
    batchId: string
    roundId: string
    epoch: number
    fingerprints: readonly string[]
    anchorRef: string
    now?: number
  },
): Promise<void> {
  await db.insert(codePublishIntents).values({
    batchId: input.batchId,
    roundId: input.roundId,
    epoch: input.epoch,
    state: 'pending',
    fingerprintsJson: JSON.stringify(input.fingerprints),
    externalIdsJson: '{}',
    anchorRef: input.anchorRef,
    createdAt: input.now ?? Date.now(),
  })
}

/**
 * Record the external ids and settle, in ONE statement.
 *
 * Atomic on purpose: a settle that wrote the state first and the ids second
 * would, if interrupted between them, produce the worst row in the system — a
 * batch that recovery SKIPS (it looks settled) whose ids the next
 * reconciliation will re-post (they are missing).
 *
 * CAS-guarded on `pending` so a retried settle cannot overwrite ids that a
 * concurrent recovery already reconciled.
 */
export async function settleIntent(
  db: DbClient,
  batchId: string,
  externalIds: Readonly<Record<string, string>>,
  now: number = Date.now(),
): Promise<boolean> {
  const updated = await db
    .update(codePublishIntents)
    .set({ state: 'settled', externalIdsJson: JSON.stringify(externalIds), settledAt: now })
    .where(and(eq(codePublishIntents.batchId, batchId), eq(codePublishIntents.state, 'pending')))
    .returning({ batchId: codePublishIntents.batchId })
  return updated.length > 0
}

/**
 * Mark a batch that never went out, or whose drafts were cleaned up.
 *
 * Kept distinct from each other: "superseded before it left" and "went out,
 * failed, cleaned up" look identical in a ledger otherwise, and they lead to
 * different questions when someone reads the history.
 */
export async function closeIntent(
  db: DbClient,
  batchId: string,
  state: 'compensated' | 'abandoned',
  now: number = Date.now(),
): Promise<boolean> {
  const updated = await db
    .update(codePublishIntents)
    .set({ state, settledAt: now })
    .where(and(eq(codePublishIntents.batchId, batchId), eq(codePublishIntents.state, 'pending')))
    .returning({ batchId: codePublishIntents.batchId })
  return updated.length > 0
}

/** Batches needing reconciliation at boot: intent written, result unknown. */
export async function readPendingIntents(db: DbClient, roundId?: string): Promise<PublishIntent[]> {
  const rows = await db
    .select()
    .from(codePublishIntents)
    .where(
      roundId === undefined
        ? eq(codePublishIntents.state, 'pending')
        : and(eq(codePublishIntents.state, 'pending'), eq(codePublishIntents.roundId, roundId)),
    )
  return rows.map(rowToIntent)
}

/**
 * Pending batches for one MR, regardless of which round wrote them.
 *
 * Keyed by anchor rather than round because that is what recovery needs: the
 * batch worth recovering belongs to the round that DIED, and the round doing
 * the recovering has a different id. Reading by round id would find only the
 * current round's own batches — always none at the point recovery runs — and
 * the pass would look like it worked while never recovering anything.
 */
export async function readPendingIntentsForAnchor(
  db: DbClient,
  anchorRef: string,
): Promise<PublishIntent[]> {
  const rows = await db
    .select()
    .from(codePublishIntents)
    .where(
      and(eq(codePublishIntents.state, 'pending'), eq(codePublishIntents.anchorRef, anchorRef)),
    )
  return rows.map(rowToIntent)
}

export async function readIntent(db: DbClient, batchId: string): Promise<PublishIntent | null> {
  const [row] = await db
    .select()
    .from(codePublishIntents)
    .where(eq(codePublishIntents.batchId, batchId))
    .limit(1)
  return row === undefined ? null : rowToIntent(row)
}

/**
 * Plan recovery for one batch against what the remote reports.
 *
 * The decision is the domain's; this exists so callers do not have to remember
 * to load the row first — forgetting that is how a recovery pass silently
 * plans against a stale in-memory copy.
 */
export async function planRecoveryFor(
  db: DbClient,
  batchId: string,
  observed: RemoteBatchObservation,
): Promise<PublishRecoveryPlan> {
  const intent = await readIntent(db, batchId)
  if (intent === null) return { action: 'none', reason: `no intent for batch '${batchId}'` }
  return planPublishRecovery(intent, observed)
}

/**
 * Abandon every pending batch of the given rounds.
 *
 * Used when a round is superseded before its call goes out. Bulk because a
 * preempted round may have several batches in flight, and leaving any of them
 * `pending` would make a later recovery pass try to reconcile work that was
 * deliberately dropped.
 */
export async function abandonIntentsOfRounds(
  db: DbClient,
  roundIds: readonly string[],
  now: number = Date.now(),
): Promise<number> {
  if (roundIds.length === 0) return 0
  const updated = await db
    .update(codePublishIntents)
    .set({ state: 'abandoned', settledAt: now })
    .where(
      and(
        inArray(codePublishIntents.roundId, [...roundIds]),
        eq(codePublishIntents.state, 'pending'),
      ),
    )
    .returning({ batchId: codePublishIntents.batchId })
  return updated.length
}
