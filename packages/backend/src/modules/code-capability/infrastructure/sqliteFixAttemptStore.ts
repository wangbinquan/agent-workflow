// RFC-304 T52/T54 — reading and claiming attempts against the retry quota.
//
// The whole point of this store is that the count survives the round. A round
// that read its own attempt number from memory would restart at 1 on every
// pipeline event, and "three attempts" would mean "forever".

import { and, asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeFixAttempts } from '@/db/schema'
import type { AttemptRecord } from '@/modules/code-capability/domain/failureFingerprint'

export interface AttemptKey {
  db: DbClient
  workItemId: string
  fingerprint: string
}

/**
 * Every attempt already made against this exact failure, oldest first.
 *
 * Ordered by `attempt_seq` and not by id: ULIDs are only monotonic across
 * milliseconds, so two attempts written inside one tick would come back in
 * arbitrary order and the hand-off comment would number them wrongly.
 */
export async function readFixAttempts(key: AttemptKey): Promise<AttemptRecord[]> {
  const rows = await key.db
    .select()
    .from(codeFixAttempts)
    .where(
      and(
        eq(codeFixAttempts.workItemId, key.workItemId),
        eq(codeFixAttempts.fingerprint, key.fingerprint),
      ),
    )
    .orderBy(asc(codeFixAttempts.attemptSeq))

  return rows.map((row) => ({
    attempt: row.attemptSeq,
    summary: row.summary,
    outcome: row.detail === null ? row.outcome : `${row.outcome}: ${row.detail}`,
  }))
}

export interface ClaimAttemptArgs extends AttemptKey {
  roundId: string
  summary: string
  outcome: 'fixed' | 'still-red' | 'rejected' | 'escalated'
  detail?: string
  now?: number
}

export type ClaimAttemptResult =
  | { ok: true; attemptSeq: number }
  /** Another round took this number first; this round is not an attempt. */
  | { ok: false; reason: 'raced' }

/**
 * Claim the next attempt number for this failure.
 *
 * The number comes from `MAX + 1` inside a transaction and is written under a
 * unique index, so the claim is the insert. Reading a count and then writing
 * `count + 1` would let two rounds on the same merge request — which happens,
 * because two pipelines can fail seconds apart — both write attempt 3, and a
 * three-attempt quota would quietly become four.
 */
export async function claimFixAttempt(args: ClaimAttemptArgs): Promise<ClaimAttemptResult> {
  const now = args.now ?? Date.now()
  const prior = await readFixAttempts(args)
  const attemptSeq = (prior.at(-1)?.attempt ?? 0) + 1

  const inserted = await args.db
    .insert(codeFixAttempts)
    .values({
      id: ulid(),
      workItemId: args.workItemId,
      fingerprint: args.fingerprint,
      attemptSeq,
      roundId: args.roundId,
      summary: args.summary,
      outcome: args.outcome,
      detail: args.detail ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: codeFixAttempts.id })

  if (inserted.length === 0) return { ok: false, reason: 'raced' }
  return { ok: true, attemptSeq }
}

/** How many attempts this failure has already consumed. */
export async function countFixAttempts(key: AttemptKey): Promise<number> {
  return (await readFixAttempts(key)).length
}
