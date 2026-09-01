// RFC-349 — PostgreSQL ownership/CAS/lease adapter. Every transition is
// fenced inside the provider transaction and returns the same domain token or
// snapshot as SQLite.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskOwnershipPersistence } from '../application/ports/taskOwnershipPersistence'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  assertExclusiveDaemonLockProof,
  assertOwnershipToken,
  assertVerifiedStopProof,
  assertVerifiedTakeoverProof,
  assertWorkerIdentity,
  createOwnershipToken,
  decideOwnerTransition,
  refreshOwnershipToken,
  type OwnerSnapshot,
} from '../domain/ownership'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
type OwnerRow = typeof taskExecutionOwners.$inferSelect

function snapshot(row: OwnerRow): OwnerSnapshot {
  return {
    taskId: row.taskId,
    ownerId: row.ownerId,
    daemonGeneration: row.daemonGeneration,
    epoch: row.epoch,
    state: row.state,
    leaseUntil: row.leaseUntil,
    revision: row.revision,
  }
}

function stale(message: string): TaskExecutionError {
  return new TaskExecutionError('task-execution-stale-owner', message)
}

function changed(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

async function serializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (attempt < 2 && retryable(error)) continue
      throw error
    }
  }
}

function retryable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (code === '40001' || code === '40P01') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

async function unresolvedEffects(tx: PgTx, taskId: string): Promise<boolean> {
  const attempts = await tx
    .select({ id: taskExecutionEffectAttempts.id })
    .from(taskExecutionEffectAttempts)
    .innerJoin(
      taskExecutionEffects,
      eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
    )
    .where(
      and(
        eq(taskExecutionEffects.taskId, taskId),
        inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
      ),
    )
    .limit(1)
  if (attempts[0] !== undefined) return true
  const holds = await tx
    .select({ id: taskExecutionEffectFences.effectAttemptId })
    .from(taskExecutionEffectFences)
    .innerJoin(
      taskExecutionEffectAttempts,
      eq(taskExecutionEffectAttempts.id, taskExecutionEffectFences.effectAttemptId),
    )
    .innerJoin(
      taskExecutionEffects,
      eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
    )
    .where(
      and(eq(taskExecutionEffects.taskId, taskId), isNull(taskExecutionEffectFences.releasedAt)),
    )
    .limit(1)
  return holds[0] !== undefined
}

export class PostgresqlTaskOwnershipPersistence implements TaskOwnershipPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async claimPendingIntent(input: Parameters<TaskOwnershipPersistence['claimPendingIntent']>[0]) {
    assertWorkerIdentity(input.identity)
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('ownership lease must be positive')
    }
    const claimed = await serializable(this.db, async (tx) => {
      const intents = await tx
        .select({
          id: taskExecutionIntents.id,
          taskId: taskExecutionIntents.taskId,
          state: taskExecutionIntents.state,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, input.intentId))
        .limit(1)
      const intent = intents[0]
      if (intent === undefined || intent.state !== 'pending') {
        throw new TaskExecutionError(
          'task-execution-owner-conflict',
          `intent '${input.intentId}' is not pending`,
        )
      }
      const maintenance = await tx
        .select({ claimId: taskExecutionMaintenanceMembers.claimId })
        .from(taskExecutionMaintenanceMembers)
        .where(
          and(
            eq(taskExecutionMaintenanceMembers.taskId, intent.taskId),
            isNull(taskExecutionMaintenanceMembers.releasedAt),
          ),
        )
        .limit(1)
      if (maintenance[0] !== undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${intent.taskId}' is claimed by terminal maintenance`,
          { claimRef: maintenance[0].claimId },
        )
      }
      const owners = await tx
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, intent.taskId))
        .limit(1)
      const old = owners[0]
      if (
        decideOwnerTransition({ current: old?.state ?? 'absent', operation: 'initial-claim' }) ===
        null
      ) {
        throw new TaskExecutionError(
          old?.state === 'recovery-required'
            ? 'task-execution-recovery-required'
            : 'task-execution-owner-conflict',
          `task '${intent.taskId}' already has owner state '${old?.state ?? 'unknown'}'`,
        )
      }
      const epoch = (old?.epoch ?? 0) + 1
      const revision = (old?.revision ?? 0) + 1
      const leaseUntil = input.now + input.leaseMs
      if (old === undefined) {
        await tx
          .insert(taskExecutionOwners)
          .values({
            taskId: intent.taskId,
            ownerId: input.identity.ownerId,
            daemonGeneration: input.identity.daemonGeneration,
            epoch,
            state: 'claimed',
            leaseUntil,
            revision,
            lastHeartbeatAt: input.now,
            recoveryCode: null,
            recoveryProofDigest: null,
            updatedAt: input.now,
          })
          .run()
      } else {
        const result = await tx
          .update(taskExecutionOwners)
          .set({
            ownerId: input.identity.ownerId,
            daemonGeneration: input.identity.daemonGeneration,
            epoch,
            state: 'claimed',
            leaseUntil,
            revision,
            lastHeartbeatAt: input.now,
            recoveryCode: null,
            recoveryProofDigest: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(taskExecutionOwners.taskId, intent.taskId),
              eq(taskExecutionOwners.state, 'released'),
              eq(taskExecutionOwners.revision, old.revision),
            ),
          )
          .run()
        if (changed(result) !== 1) throw stale(`task '${intent.taskId}' owner claim lost`)
      }
      const intentClaim = await tx
        .update(taskExecutionIntents)
        .set({ state: 'claimed', claimedEpoch: epoch, claimedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(taskExecutionIntents.id, input.intentId),
            eq(taskExecutionIntents.state, 'pending'),
          ),
        )
        .run()
      if (changed(intentClaim) !== 1) throw stale(`intent '${input.intentId}' claim lost`)
      return { taskId: intent.taskId, epoch, leaseUntil, revision }
    })
    return createOwnershipToken({
      taskId: claimed.taskId,
      identity: input.identity,
      epoch: claimed.epoch,
      leaseUntil: claimed.leaseUntil,
      ownerRevision: claimed.revision,
    })
  }

  async heartbeat(input: Parameters<TaskOwnershipPersistence['heartbeat']>[0]) {
    assertOwnershipToken(input.token)
    const rows = await this.db
      .update(taskExecutionOwners)
      .set({
        revision: sql`${taskExecutionOwners.revision} + 1`,
        leaseUntil: input.now + input.leaseMs,
        lastHeartbeatAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionOwners.taskId, input.token.taskId),
          eq(taskExecutionOwners.ownerId, input.token.ownerId),
          eq(taskExecutionOwners.daemonGeneration, input.token.daemonGeneration),
          eq(taskExecutionOwners.epoch, input.token.epoch),
          eq(taskExecutionOwners.state, 'claimed'),
        ),
      )
      .returning({
        revision: taskExecutionOwners.revision,
        leaseUntil: taskExecutionOwners.leaseUntil,
      })
    const row = rows[0]
    if (row === undefined) throw stale(`task '${input.token.taskId}' heartbeat was fenced`)
    return refreshOwnershipToken({
      token: input.token,
      leaseUntil: row.leaseUntil,
      ownerRevision: row.revision,
    })
  }

  async revokeExact(input: Parameters<TaskOwnershipPersistence['revokeExact']>[0]) {
    const rows = await this.db
      .update(taskExecutionOwners)
      .set({
        state: 'revoked',
        revision: input.expectedRevision + 1,
        recoveryCode: input.recoveryCode ?? null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionOwners.taskId, input.owner.taskId),
          eq(taskExecutionOwners.ownerId, input.owner.ownerId),
          eq(taskExecutionOwners.daemonGeneration, input.owner.daemonGeneration),
          eq(taskExecutionOwners.epoch, input.owner.epoch),
          eq(taskExecutionOwners.revision, input.expectedRevision),
          eq(taskExecutionOwners.state, 'claimed'),
        ),
      )
      .returning()
    const row = rows[0]
    if (row === undefined) throw stale(`task '${input.owner.taskId}' revoke lost`)
    return snapshot(row)
  }

  async revokeOldDaemon(input: Parameters<TaskOwnershipPersistence['revokeOldDaemon']>[0]) {
    assertExclusiveDaemonLockProof(input.lockProof)
    if (input.lockProof.daemonGeneration === input.owner.daemonGeneration) {
      throw new Error('new-daemon revoke requires a successor daemon generation')
    }
    return await this.revokeExact({
      owner: input.owner,
      expectedRevision: input.expectedRevision,
      now: input.now,
      recoveryCode: 'daemon-lock-successor',
    })
  }

  async markRecoveryRequired(
    input: Parameters<TaskOwnershipPersistence['markRecoveryRequired']>[0],
  ) {
    assertOwnershipToken(input.token)
    const rows = await this.db
      .update(taskExecutionOwners)
      .set({
        state: 'recovery-required',
        revision: input.expectedRevision + 1,
        recoveryCode: input.code,
        recoveryProofDigest: input.evidenceDigest ?? null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionOwners.taskId, input.token.taskId),
          eq(taskExecutionOwners.ownerId, input.token.ownerId),
          eq(taskExecutionOwners.daemonGeneration, input.token.daemonGeneration),
          eq(taskExecutionOwners.epoch, input.token.epoch),
          eq(taskExecutionOwners.revision, input.expectedRevision),
          inArray(taskExecutionOwners.state, ['claimed', 'revoked']),
        ),
      )
      .returning()
    const row = rows[0]
    if (row === undefined) {
      throw stale(`task '${input.token.taskId}' recovery transition was fenced`)
    }
    return snapshot(row)
  }

  async releaseAfterStop(input: Parameters<TaskOwnershipPersistence['releaseAfterStop']>[0]) {
    assertOwnershipToken(input.token)
    assertVerifiedStopProof(input.proof)
    if (input.proof.taskId !== input.token.taskId || input.proof.epoch !== input.token.epoch) {
      throw new Error('stop proof does not match ownership token')
    }
    return await serializable(this.db, async (tx) => {
      if (await unresolvedEffects(tx, input.token.taskId)) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `task '${input.token.taskId}' still has unresolved effects or resource holds`,
        )
      }
      const rows = await tx
        .update(taskExecutionOwners)
        .set({
          state: 'released',
          revision: sql`${taskExecutionOwners.revision} + 1`,
          recoveryCode: null,
          recoveryProofDigest: input.proof.evidenceDigest,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskExecutionOwners.taskId, input.token.taskId),
            eq(taskExecutionOwners.ownerId, input.token.ownerId),
            eq(taskExecutionOwners.daemonGeneration, input.token.daemonGeneration),
            eq(taskExecutionOwners.epoch, input.token.epoch),
            eq(taskExecutionOwners.revision, input.proof.ownerRevision),
            inArray(taskExecutionOwners.state, ['claimed', 'revoked', 'recovery-required']),
          ),
        )
        .returning()
      const row = rows[0]
      if (row === undefined) throw stale(`task '${input.token.taskId}' release was fenced`)
      await tx
        .update(taskExecutionIntents)
        .set({ state: 'completed', completedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(taskExecutionIntents.id, input.intentId),
            eq(taskExecutionIntents.claimedEpoch, input.token.epoch),
            eq(taskExecutionIntents.state, 'claimed'),
          ),
        )
        .run()
      return snapshot(row)
    })
  }

  async releaseRecovered(input: Parameters<TaskOwnershipPersistence['releaseRecovered']>[0]) {
    assertVerifiedTakeoverProof(input.proof)
    if (
      input.proof.taskId !== input.owner.taskId ||
      input.proof.oldEpoch !== input.owner.epoch ||
      input.proof.oldOwnerRevision !== input.expectedRevision
    ) {
      throw new Error('takeover proof does not match recovered owner')
    }
    return await serializable(this.db, async (tx) => {
      if (await unresolvedEffects(tx, input.owner.taskId)) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `task '${input.owner.taskId}' still has unresolved effects`,
        )
      }
      await tx
        .update(taskExecutionIntents)
        .set({
          state: 'failed',
          failureCode: 'daemon-restart-recovered',
          completedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskExecutionIntents.taskId, input.owner.taskId),
            eq(taskExecutionIntents.claimedEpoch, input.owner.epoch),
            inArray(taskExecutionIntents.state, ['pending', 'claimed']),
          ),
        )
        .run()
      const rows = await tx
        .update(taskExecutionOwners)
        .set({
          state: 'released',
          revision: input.expectedRevision + 1,
          recoveryCode: 'daemon-restart-recovered',
          recoveryProofDigest: input.proof.evidenceDigest,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskExecutionOwners.taskId, input.owner.taskId),
            eq(taskExecutionOwners.ownerId, input.owner.ownerId),
            eq(taskExecutionOwners.daemonGeneration, input.owner.daemonGeneration),
            eq(taskExecutionOwners.epoch, input.owner.epoch),
            eq(taskExecutionOwners.revision, input.expectedRevision),
            inArray(taskExecutionOwners.state, ['revoked', 'recovery-required']),
          ),
        )
        .returning()
      const row = rows[0]
      if (row === undefined) throw stale(`task '${input.owner.taskId}' recovery release lost`)
      return snapshot(row)
    })
  }

  async read(taskId: string) {
    const rows = await this.db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
      .limit(1)
    return rows[0] === undefined ? null : snapshot(rows[0])
  }
}
