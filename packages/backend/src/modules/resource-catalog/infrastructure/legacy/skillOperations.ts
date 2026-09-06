// RFC-170 §6a — skill_operations two-phase-commit state machine primitives.
//
// The composable DB layer every structural skill op (reserve / migrate / delete /
// version-write) is built on. Pure DB (no FS): the
// caller interleaves FS side effects between phase commits per §6a invariants:
//   ① before ANY FS side effect, the phase='intent' row is COMMITted (locks
//      acquired in the SAME tx);
//   ② each FS step is followed by its own phase-advance COMMIT;
//   ③ phase='db-committed' shares the tx with the authoritative skills write;
//   ⑤ finishOperation sets phase='done' + active=0 and releases locks same-tx.
//
// skill_operation_locks is the UNIVERSAL exclusion primitive (G6-2): EVERY op
// inserts one lock row for its skillId. PK conflict → ConflictError (409 busy).
// Locks are held until phase='done' (released in finishOperation's tx), so a
// swap-committed-but-backup-not-cleaned window still excludes a new-id op.
//
// All mutators take a DatabaseTransaction so they compose into the caller's transaction;
// read helpers accept either a tx or the database handle.
//
// RFC-359 W4-D23b：这一层从 `dbTxSync` 的**同步** SQLite 面迁到中立事务原语
// （`platform/persistence/databaseTransaction.ts`），两个 provider 才可能共用同一套崩溃安全机器。
// 语义逐条不变：阶段边界仍是各自独立的一笔提交，锁仍与意图行同事务、活到 done 为止。

import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { skillOperations, skillOperationLocks } from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'

/**
 * The managed structural op kinds. RFC-178 removed `replace` (source-conflict —
 * source skills gone) and `adopt-managed` (external adoption — external skills
 * gone); neither was ever produced (no beginOperation emitted them). The DB CHECK
 * from migration 0090 keeps the wider superset (harmless — no row ever carries the
 * removed kinds). RFC-279 narrowed the physical CHECK to this same set.
 */
export type SkillOpKind = 'reserve' | 'migrate' | 'delete' | 'version-write'

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
export async function acquireOpLocks(
  tx: DatabaseTransaction,
  opId: string,
  skillIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(skillIds)]
  for (const id of unique) {
    try {
      await tx.insert(skillOperationLocks).values({ lockedSkillId: id, opId })
    } catch (err) {
      // PRIMARY KEY / UNIQUE violation → the skill is busy under another op.
      if (isUniqueViolation(tx, err)) {
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
export async function releaseOpLocks(tx: DatabaseTransaction, opId: string): Promise<void> {
  await tx.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, opId))
}

/**
 * §6a step ①: durably record intent. INSERTs the op row at phase='intent',
 * active=1, and acquires the lock for the skill in
 * the SAME tx — so a crash after this leaves a recoverable, locked op. Returns
 * the generated opId. Wrap in a session transaction; a busy-lock throw rolls the
 * whole tx back (no orphan op row).
 */
export async function beginOperation(
  tx: DatabaseTransaction,
  spec: BeginOperationSpec,
): Promise<string> {
  const opId = ulid()
  await acquireOpLocks(tx, opId, [spec.skillId])
  await tx.insert(skillOperations).values({
    opId,
    skillId: spec.skillId,
    kind: spec.kind,
    phase: 'intent',
    active: 1,
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
  return opId
}

/**
 * §6a step ②: advance the phase after an FS side effect (its own COMMIT), or —
 * for db-committed — inside the caller's authoritative-write tx. `patch` lets a
 * step persist newly-produced paths/fingerprints (e.g. candidate_fingerprint
 * after capture). Throws if the op is absent or already inactive.
 */
export async function advancePhase(
  tx: DatabaseTransaction,
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
): Promise<void> {
  // Read-then-check inside the caller's tx (the update result carries no affected-row
  // count across both engines). Atomic within the surrounding transaction.
  const existing = (
    await tx
      .select({ active: skillOperations.active })
      .from(skillOperations)
      .where(eq(skillOperations.opId, opId))
      .limit(1)
  )[0]
  if (!existing || existing.active !== 1) {
    throw new ValidationError(
      'skill-operation-inactive',
      `skill operation ${opId} not found or already inactive`,
    )
  }
  await tx
    .update(skillOperations)
    .set({ phase, ...patch })
    .where(eq(skillOperations.opId, opId))
}

/**
 * §6a step ⑤: terminal success. Sets phase='done' + active=0 and releases the
 * op's locks in ONE tx (invariant: locks live until done, not db-committed).
 */
export async function finishOperation(tx: DatabaseTransaction, opId: string): Promise<void> {
  await tx
    .update(skillOperations)
    .set({ phase: 'done', active: 0 })
    .where(eq(skillOperations.opId, opId))
  await releaseOpLocks(tx, opId)
}

/**
 * Rollback terminal: mark the op inactive and release its locks. The row is
 * retained (active=0) for audit; recovery treats absent-or-inactive identically.
 */
export async function abandonOperation(tx: DatabaseTransaction, opId: string): Promise<void> {
  await tx.update(skillOperations).set({ active: 0 }).where(eq(skillOperations.opId, opId))
  await releaseOpLocks(tx, opId)
}

function ops(dbOrTx: ProviderNeutralDatabase | DatabaseTransaction): DatabaseTransaction {
  return dbOrTx as DatabaseTransaction
}

/** The single active op for a skill (its own skill_id), if any. Recovery reads. */
export async function getActiveOp(
  dbOrTx: ProviderNeutralDatabase | DatabaseTransaction,
  skillId: string,
): Promise<SkillOperationRow | null> {
  const rows = await ops(dbOrTx)
    .select()
    .from(skillOperations)
    .where(and(eq(skillOperations.skillId, skillId), eq(skillOperations.active, 1)))
    .limit(1)
  return rows[0] ?? null
}

/** All active ops (boot recovery iterates these while locks are still held). */
export async function listActiveOps(
  dbOrTx: ProviderNeutralDatabase | DatabaseTransaction,
): Promise<SkillOperationRow[]> {
  return await ops(dbOrTx).select().from(skillOperations).where(eq(skillOperations.active, 1))
}

/** Orphan locks whose op is done/absent — GC'd AFTER active-op recovery (§6a). */
export async function listOrphanLocks(
  dbOrTx: ProviderNeutralDatabase | DatabaseTransaction,
): Promise<(typeof skillOperationLocks.$inferSelect)[]> {
  const t = ops(dbOrTx)
  const active = await t
    .select({ opId: skillOperations.opId })
    .from(skillOperations)
    .where(eq(skillOperations.active, 1))
  const activeOpIds = new Set(active.map((r) => r.opId))
  const locks = await t.select().from(skillOperationLocks)
  return locks.filter((lock) => !activeOpIds.has(lock.opId))
}

/** GC orphan locks (post-recovery). Deletes locks not owned by any active op. */
export async function gcOrphanLocks(tx: DatabaseTransaction): Promise<number> {
  const orphans = await listOrphanLocks(tx)
  if (orphans.length === 0) return 0
  await tx.delete(skillOperationLocks).where(
    inArray(
      skillOperationLocks.lockedSkillId,
      orphans.map((o) => o.lockedSkillId),
    ),
  )
  return orphans.length
}

/** 唯一冲突的判别交给引擎能力面——驱动错误形状是 provider 差异的唯一容身处（RFC-359）。 */
function isUniqueViolation(tx: DatabaseTransaction, err: unknown): boolean {
  return engineOf(tx).classifyError(err) === 'unique-violation'
}
