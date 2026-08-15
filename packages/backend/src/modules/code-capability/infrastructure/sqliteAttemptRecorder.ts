// RFC-304 T2b — persisting one row per AI call, and surviving a crash.
//
// The recovery rule is the whole reason this is not a two-line insert/update.
// Design §3: a daemon that dies before writing `validation_outcome` leaves a
// row in `claimed`/`running`. If a restart then re-ran the stage, the guard
// would hand out the same `(rerunSeq, attemptSeq)` pair it used before and the
// insert would collide with the unique key — so recovery must do two things, in
// this order:
//
//   1. settle every dangling attempt of the round to `interrupted`, so the
//      history says what happened rather than leaving rows that look in-flight
//      forever;
//   2. allocate the NEXT `attemptSeq` above whatever already exists, so the new
//      attempts do not collide with the interrupted ones.
//
// Doing (2) without (1) leaves phantom in-flight rows; doing (1) without (2)
// crashes on the first retry after a restart. Both orders of that pair are a
// real bug, which is why the order is stated here and locked by a test.

import { and, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeAiAttempts } from '@/db/schema'
import type { AttemptRecorder } from '@/modules/code-capability/application/determinismGuard'

export interface AttemptScope {
  roundId: string
  stageName: string
  /** '' for a stage that makes a single call. */
  shardKey: string
}

/**
 * Settle every attempt of `roundId` that is still claimed/running.
 *
 * Called on daemon restart BEFORE any stage of that round re-runs. Returns how
 * many rows were settled, which is what the recovery log reports — "recovered
 * 0" and "recovered 7" are very different mornings.
 */
export async function settleDanglingAttempts(db: DbClient, roundId: string): Promise<number> {
  const settled = await db
    .update(codeAiAttempts)
    .set({ status: 'interrupted', endedAt: Date.now(), validationOutcome: 'daemon-restart' })
    .where(
      and(
        eq(codeAiAttempts.roundId, roundId),
        inArray(codeAiAttempts.status, ['claimed', 'running']),
      ),
    )
    .returning({ id: codeAiAttempts.id })
  return settled.length
}

/**
 * Build a recorder bound to one (round, stage, shard).
 *
 * `now` is injectable because the tests assert on ordering, and a real clock
 * makes "which of these two rows came first" a coin flip inside one millisecond.
 */
export function createSqliteAttemptRecorder(
  db: DbClient,
  scope: AttemptScope,
  now: () => number = Date.now,
): AttemptRecorder {
  return {
    async claim(input) {
      // The guard hands us its LOGICAL attempt number (0, 1, 2 within this
      // session). After a restart those numbers are already taken by the
      // interrupted rows, so the stored seq is lifted above the existing max
      // rather than trusted verbatim. The guard's control flow does not depend
      // on the stored value; the audit trail does.
      const [existing] = await db
        .select({ maxSeq: sql<number | null>`max(${codeAiAttempts.attemptSeq})` })
        .from(codeAiAttempts)
        .where(
          and(
            eq(codeAiAttempts.roundId, scope.roundId),
            eq(codeAiAttempts.stageName, scope.stageName),
            eq(codeAiAttempts.shardKey, scope.shardKey),
            eq(codeAiAttempts.rerunSeq, input.rerunSeq),
          ),
        )
      const maxSeq = existing?.maxSeq ?? null
      const attemptSeq = maxSeq === null ? input.attemptSeq : Math.max(input.attemptSeq, maxSeq + 1)

      const id = ulid()
      await db.insert(codeAiAttempts).values({
        id,
        roundId: scope.roundId,
        stageName: scope.stageName,
        shardKey: scope.shardKey,
        rerunSeq: input.rerunSeq,
        attemptSeq,
        status: 'running',
        startedAt: now(),
      })
      return id
    },

    async settle(input) {
      await db
        .update(codeAiAttempts)
        .set({
          status: input.status,
          validationOutcome: input.validationOutcome,
          sessionRef: input.sessionRef,
          endedAt: now(),
        })
        .where(eq(codeAiAttempts.id, input.attemptId))
    },
  }
}

/** Read a round's attempts in execution order — the state view's third level. */
export async function readRoundAttempts(
  db: DbClient,
  roundId: string,
): Promise<
  Array<{
    stageName: string
    shardKey: string
    rerunSeq: number
    attemptSeq: number
    status: string
    validationOutcome: string | null
    sessionRef: string | null
  }>
> {
  return await db
    .select({
      stageName: codeAiAttempts.stageName,
      shardKey: codeAiAttempts.shardKey,
      rerunSeq: codeAiAttempts.rerunSeq,
      attemptSeq: codeAiAttempts.attemptSeq,
      status: codeAiAttempts.status,
      validationOutcome: codeAiAttempts.validationOutcome,
      sessionRef: codeAiAttempts.sessionRef,
    })
    .from(codeAiAttempts)
    .where(eq(codeAiAttempts.roundId, roundId))
    .orderBy(
      codeAiAttempts.stageName,
      codeAiAttempts.shardKey,
      codeAiAttempts.rerunSeq,
      codeAiAttempts.attemptSeq,
    )
}
