// RFC-170 §6a — skill_operations two-phase-commit state machine primitives.
//
// The composable DB layer every structural skill op (reserve / replace / migrate
// / delete / version-write / adopt-managed) is built on. Pure DB (no FS): the
// caller interleaves FS side effects between phase commits per §6a invariants:
//   ① before ANY FS side effect, the phase='intent' row is COMMITted (locks
//      acquired in the SAME tx);
//   ② each FS step is followed by its own phase-advance COMMIT;
//   ③ phase='db-committed' shares the tx with the authoritative skills write;
//   ⑤ finishOperation sets phase='done' + active=0 and releases locks same-tx.
//
// skill_operation_locks is the UNIVERSAL exclusion primitive (G6-2): EVERY op
// inserts one lock row per affected skillId (single-id ops lock 1, replace locks
// old+new). PK conflict on any target → ConflictError (409 busy). This locks the
// SECOND id (replace's next_skill_id) that the ops-table partial-unique cannot.
// Locks are held until phase='done' (released in finishOperation's tx), so a
// swap-committed-but-backup-not-cleaned window still excludes a new-id op.
//
// All mutators take a DbTxSync so they compose into the caller's transaction;
// read helpers accept either a tx or the DbClient.

import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { skillOperations, skillOperationLocks } from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'

/** The six structural op kinds (mirrors the migration-0090 CHECK). */
export type SkillOpKind =
  | 'reserve'
  | 'replace'
  | 'migrate'
  | 'delete'
  | 'version-write'
  | 'adopt-managed'

/** Ordered lifecycle phases. Not every kind uses every phase (see §6a per-kind
 *  tables); the set is the union. `intent` < ... < `db-committed` is the rollback
 *  vs roll-forward boundary (db-committed is the roll-forward side). */
export type SkillOpPhase =
  | 'intent'
  | 'fs-staged'
  | 'fs-captured'
  | 'fs-versioned'
  | 'fs-published'
  | 'db-committed'
  | 'done'

export interface BeginOperationSpec {
  skillId: string
  kind: SkillOpKind
  /** replace/reserve-into-slot: the SECOND affected skillId, also locked. */
  nextSkillId?: string
  stagingPath?: string
  backupPath?: string
  candidatePath?: string
  candidateFingerprint?: string
  backupFingerprint?: string
  targetVersion?: number
  generation?: number
  ownerUserId?: string
  /** adopt-managed (§7a G10-1): full serialized precondition for phase-B CAS. */
  preconditionJson?: string
}

export type SkillOperationRow = typeof skillOperations.$inferSelect

/**
 * Acquire the exclusion locks for an op: one row per affected skillId. PK
 * conflict on ANY id (another active op holds it) → ConflictError. Must run in
 * the SAME tx as the op-row INSERT (intent tx).
 */
export function acquireOpLocks(tx: DbTxSync, opId: string, skillIds: readonly string[]): void {
  const unique = [...new Set(skillIds)]
  for (const id of unique) {
    try {
      tx.insert(skillOperationLocks).values({ lockedSkillId: id, opId }).run()
    } catch (err) {
      // SQLite PRIMARY KEY / UNIQUE violation → the skill is busy under another op.
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          'skill-operation-busy',
          `skill ${id} is busy under another operation`,
        )
      }
      throw err
    }
  }
}

/** Release every lock held by this op (finish or rollback). Same-tx as the
 *  terminal state write. */
export function releaseOpLocks(tx: DbTxSync, opId: string): void {
  tx.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, opId)).run()
}

/**
 * §6a step ①: durably record intent. INSERTs the op row at phase='intent',
 * active=1, and acquires locks for the skill (plus nextSkillId when present) in
 * the SAME tx — so a crash after this leaves a recoverable, locked op. Returns
 * the generated opId. Wrap in dbTxSync; a busy-lock throw rolls the whole tx
 * back (no orphan op row).
 */
export function beginOperation(tx: DbTxSync, spec: BeginOperationSpec): string {
  const opId = ulid()
  const affected = spec.nextSkillId ? [spec.skillId, spec.nextSkillId] : [spec.skillId]
  acquireOpLocks(tx, opId, affected)
  tx.insert(skillOperations)
    .values({
      opId,
      skillId: spec.skillId,
      kind: spec.kind,
      phase: 'intent',
      active: 1,
      nextSkillId: spec.nextSkillId ?? null,
      stagingPath: spec.stagingPath ?? null,
      backupPath: spec.backupPath ?? null,
      candidatePath: spec.candidatePath ?? null,
      candidateFingerprint: spec.candidateFingerprint ?? null,
      backupFingerprint: spec.backupFingerprint ?? null,
      targetVersion: spec.targetVersion ?? null,
      generation: spec.generation ?? null,
      ownerUserId: spec.ownerUserId ?? null,
      preconditionJson: spec.preconditionJson ?? null,
    })
    .run()
  return opId
}

/**
 * §6a step ②: advance the phase after an FS side effect (its own COMMIT), or —
 * for db-committed — inside the caller's authoritative-write tx. `patch` lets a
 * step persist newly-produced paths/fingerprints (e.g. candidate_fingerprint
 * after capture). Throws if the op is absent or already inactive.
 */
export function advancePhase(
  tx: DbTxSync,
  opId: string,
  phase: SkillOpPhase,
  patch: Partial<
    Pick<
      SkillOperationRow,
      | 'stagingPath'
      | 'backupPath'
      | 'candidatePath'
      | 'candidateFingerprint'
      | 'backupFingerprint'
      | 'targetVersion'
      | 'generation'
    >
  > = {},
): void {
  // Read-then-check inside the caller's tx (drizzle .run() is typed void here, so
  // affected-row count isn't available). Atomic within dbTxSync.
  const existing = tx
    .select({ active: skillOperations.active })
    .from(skillOperations)
    .where(eq(skillOperations.opId, opId))
    .get()
  if (!existing || existing.active !== 1) {
    throw new ValidationError(
      'skill-operation-inactive',
      `skill operation ${opId} not found or already inactive`,
    )
  }
  tx.update(skillOperations)
    .set({ phase, ...patch })
    .where(eq(skillOperations.opId, opId))
    .run()
}

/**
 * §6a step ⑤: terminal success. Sets phase='done' + active=0 and releases the
 * op's locks in ONE tx (invariant: locks live until done, not db-committed).
 */
export function finishOperation(tx: DbTxSync, opId: string): void {
  tx.update(skillOperations)
    .set({ phase: 'done', active: 0 })
    .where(eq(skillOperations.opId, opId))
    .run()
  releaseOpLocks(tx, opId)
}

/**
 * Rollback terminal: mark the op inactive and release its locks. The row is
 * retained (active=0) for audit; recovery treats absent-or-inactive identically.
 */
export function abandonOperation(tx: DbTxSync, opId: string): void {
  tx.update(skillOperations).set({ active: 0 }).where(eq(skillOperations.opId, opId)).run()
  releaseOpLocks(tx, opId)
}

function ops(dbOrTx: DbClient | DbTxSync) {
  return dbOrTx as DbTxSync
}

/** The single active op for a skill (its own skill_id), if any. Recovery reads. */
export function getActiveOp(
  dbOrTx: DbClient | DbTxSync,
  skillId: string,
): SkillOperationRow | null {
  return (
    ops(dbOrTx)
      .select()
      .from(skillOperations)
      .where(and(eq(skillOperations.skillId, skillId), eq(skillOperations.active, 1)))
      .get() ?? null
  )
}

/** All active ops (boot recovery iterates these while locks are still held). */
export function listActiveOps(dbOrTx: DbClient | DbTxSync): SkillOperationRow[] {
  return ops(dbOrTx).select().from(skillOperations).where(eq(skillOperations.active, 1)).all()
}

/** Orphan locks whose op is done/absent — GC'd AFTER active-op recovery (§6a). */
export function listOrphanLocks(
  dbOrTx: DbClient | DbTxSync,
): (typeof skillOperationLocks.$inferSelect)[] {
  const t = ops(dbOrTx)
  const active = t
    .select({ opId: skillOperations.opId })
    .from(skillOperations)
    .where(eq(skillOperations.active, 1))
    .all()
  const activeOpIds = new Set(active.map((r) => r.opId))
  return t
    .select()
    .from(skillOperationLocks)
    .all()
    .filter((lock) => !activeOpIds.has(lock.opId))
}

/** GC orphan locks (post-recovery). Deletes locks not owned by any active op. */
export function gcOrphanLocks(tx: DbTxSync): number {
  const orphans = listOrphanLocks(tx)
  if (orphans.length === 0) return 0
  tx.delete(skillOperationLocks)
    .where(
      inArray(
        skillOperationLocks.lockedSkillId,
        orphans.map((o) => o.lockedSkillId),
      ),
    )
    .run()
  return orphans.length
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed|PRIMARY KEY|SQLITE_CONSTRAINT_PRIMARYKEY|constraint failed/i.test(
    msg,
  )
}
