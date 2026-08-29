import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
} from '@/db/schema'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import type { TaskOwnershipStore } from '../application/ports/taskOwnershipStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import { terminalizeTaskExecutionIntentsTx } from '../application/terminalizeExecutionIntent'
import {
  assertExclusiveDaemonLockProof,
  assertOwnershipToken,
  assertVerifiedStopProof,
  assertVerifiedTakeoverProof,
  assertWorkerIdentity,
  createOwnedTaskTx,
  createOwnershipToken,
  decideOwnerTransition,
  ownershipTuple,
  refreshOwnershipToken,
  type ExclusiveDaemonLockProof,
  type OwnedTaskTx,
  type OwnerSnapshot,
  type OwnershipToken,
  type OwnershipTuple,
  type VerifiedStopProof,
  type VerifiedTakeoverProof,
  type WorkerIdentity,
} from '../domain/ownership'

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

function staleOwner(message: string): TaskExecutionError {
  return new TaskExecutionError('task-execution-stale-owner', message)
}

export class SqliteTaskOwnershipStore implements TaskOwnershipStore {
  claimPendingIntent(input: {
    db: DbClient
    intentId: string
    identity: WorkerIdentity
    now: number
    leaseMs: number
  }): OwnershipToken {
    assertWorkerIdentity(input.identity)
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('ownership lease must be positive')
    }
    const claimed = dbTxSync(input.db, (tx) => {
      const intent = tx
        .select({
          id: taskExecutionIntents.id,
          taskId: taskExecutionIntents.taskId,
          state: taskExecutionIntents.state,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, input.intentId))
        .get()
      if (intent === undefined || intent.state !== 'pending') {
        throw new TaskExecutionError(
          'task-execution-owner-conflict',
          `intent '${input.intentId}' is not pending`,
        )
      }
      const maintenance = tx
        .select({ claimId: taskExecutionMaintenanceMembers.claimId })
        .from(taskExecutionMaintenanceMembers)
        .where(
          and(
            eq(taskExecutionMaintenanceMembers.taskId, intent.taskId),
            isNull(taskExecutionMaintenanceMembers.releasedAt),
          ),
        )
        .get()
      if (maintenance !== undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${intent.taskId}' is claimed by terminal maintenance`,
          { claimRef: maintenance.claimId },
        )
      }

      const old = tx
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, intent.taskId))
        .get()
      const transition = decideOwnerTransition({
        current: old?.state ?? 'absent',
        operation: 'initial-claim',
      })
      if (transition === null) {
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
        tx.insert(taskExecutionOwners)
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
        const updated = tx
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
          .returning({ revision: taskExecutionOwners.revision })
          .get()
        if (updated === undefined) throw staleOwner(`task '${intent.taskId}' owner claim lost`)
      }
      const intentClaim = tx
        .update(taskExecutionIntents)
        .set({
          state: 'claimed',
          claimedEpoch: epoch,
          claimedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskExecutionIntents.id, input.intentId),
            eq(taskExecutionIntents.state, 'pending'),
          ),
        )
        .returning({ id: taskExecutionIntents.id })
        .get()
      if (intentClaim === undefined) throw staleOwner(`intent '${input.intentId}' claim lost`)
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

  heartbeat(input: {
    db: DbClient
    token: OwnershipToken
    now: number
    leaseMs: number
  }): OwnershipToken {
    assertOwnershipToken(input.token)
    const row = input.db
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
      .get()
    if (row === undefined) throw staleOwner(`task '${input.token.taskId}' heartbeat was fenced`)
    // A heartbeat returns a fresh immutable token snapshot.  Exact ownership
    // identity/epoch is unchanged; callers may atomically replace their copy.
    return refreshOwnershipToken({
      token: input.token,
      leaseUntil: row.leaseUntil,
      ownerRevision: row.revision,
    })
  }

  withOwnedTaskTx<T>(input: {
    db: DbClient
    token: OwnershipToken
    now: number
    run: (tx: DbTxSync, owned: OwnedTaskTx) => T
  }): T {
    assertOwnershipToken(input.token)
    return dbTxSync(input.db, (tx) => {
      const fenced = tx
        .update(taskExecutionOwners)
        .set({
          revision: sql`${taskExecutionOwners.revision} + 1`,
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
        .returning({ revision: taskExecutionOwners.revision })
        .get()
      if (fenced === undefined) {
        throw staleOwner(`task '${input.token.taskId}' mutation was fenced by a newer owner`)
      }
      return input.run(
        tx,
        createOwnedTaskTx({ token: input.token, revision: fenced.revision }),
      ) as NotPromise<T>
    })
  }

  revokeExact(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    now: number
    recoveryCode?: string
  }): OwnerSnapshot {
    return dbTxSync(input.db, (tx) =>
      this.revokeExactTx({
        tx,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        now: input.now,
        ...(input.recoveryCode !== undefined ? { recoveryCode: input.recoveryCode } : {}),
      }),
    )
  }

  revokeExactTx(input: {
    tx: DbTxSync
    owner: OwnershipTuple
    expectedRevision: number
    now: number
    recoveryCode?: string
  }): OwnerSnapshot {
    const row = input.tx
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
      .get()
    if (row === undefined) throw staleOwner(`task '${input.owner.taskId}' revoke lost`)
    return snapshot(row)
  }

  revokeOldDaemon(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    lockProof: ExclusiveDaemonLockProof
    now: number
  }): OwnerSnapshot {
    assertExclusiveDaemonLockProof(input.lockProof)
    if (input.lockProof.daemonGeneration === input.owner.daemonGeneration) {
      throw new Error('new-daemon revoke requires a successor daemon generation')
    }
    return this.revokeExact({
      db: input.db,
      owner: input.owner,
      expectedRevision: input.expectedRevision,
      now: input.now,
      recoveryCode: 'daemon-lock-successor',
    })
  }

  markRecoveryRequired(input: {
    db: DbClient
    token: OwnershipToken
    expectedRevision: number
    code: string
    evidenceDigest?: string | null
    now: number
  }): OwnerSnapshot {
    assertOwnershipToken(input.token)
    const row = input.db
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
      .get()
    if (row === undefined) {
      throw staleOwner(`task '${input.token.taskId}' recovery transition was fenced`)
    }
    return snapshot(row)
  }

  releaseAfterStop(input: {
    db: DbClient
    token: OwnershipToken
    intentId: string
    proof: VerifiedStopProof
    now: number
  }): OwnerSnapshot {
    assertOwnershipToken(input.token)
    assertVerifiedStopProof(input.proof)
    if (input.proof.taskId !== input.token.taskId || input.proof.epoch !== input.token.epoch) {
      throw new Error('stop proof does not match ownership token')
    }
    return dbTxSync(input.db, (tx) => {
      const unresolved = tx
        .select({ id: taskExecutionEffectAttempts.id })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(
          and(
            eq(taskExecutionEffects.taskId, input.token.taskId),
            inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
          ),
        )
        .get()
      const activeHold = tx
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
          and(
            eq(taskExecutionEffects.taskId, input.token.taskId),
            isNull(taskExecutionEffectFences.releasedAt),
          ),
        )
        .get()
      // An open effect whose latest attempt is retry-authorized is a durable
      // continuation point, not an acting writer: its resource holds were
      // released in the same settlement transaction.  Allow the owner to
      // yield so the next legitimate continuation can perform the already-
      // authorized same-generation retry. Prepared/acting/recovery-required
      // attempts and any surviving hold still block release above/below.
      if (unresolved !== undefined || activeHold !== undefined) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `task '${input.token.taskId}' still has unresolved effects or resource holds`,
        )
      }
      const row = tx
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
        .get()
      if (row === undefined) throw staleOwner(`task '${input.token.taskId}' release was fenced`)
      tx.update(taskExecutionIntents)
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

  releaseRecovered(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    proof: VerifiedTakeoverProof
    now: number
  }): OwnerSnapshot {
    assertVerifiedTakeoverProof(input.proof)
    if (
      input.proof.taskId !== input.owner.taskId ||
      input.proof.oldEpoch !== input.owner.epoch ||
      input.proof.oldOwnerRevision !== input.expectedRevision
    ) {
      throw new Error('takeover proof does not match recovered owner')
    }
    return dbTxSync(input.db, (tx) => {
      const unresolved = tx
        .select({ id: taskExecutionEffectAttempts.id })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(
          and(
            eq(taskExecutionEffects.taskId, input.owner.taskId),
            inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
          ),
        )
        .get()
      const activeHold = tx
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
          and(
            eq(taskExecutionEffects.taskId, input.owner.taskId),
            isNull(taskExecutionEffectFences.releasedAt),
          ),
        )
        .get()
      if (unresolved !== undefined || activeHold !== undefined) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `task '${input.owner.taskId}' still has unresolved effects`,
        )
      }
      terminalizeTaskExecutionIntentsTx({
        tx,
        taskId: input.owner.taskId,
        state: 'failed',
        failureCode: 'daemon-restart-recovered',
        now: input.now,
        claimedOwnerEpoch: input.owner.epoch,
      })
      const row = tx
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
        .get()
      if (row === undefined) throw staleOwner(`task '${input.owner.taskId}' recovery release lost`)
      return snapshot(row)
    })
  }

  read(db: DbClient, taskId: string): OwnerSnapshot | null {
    const row = db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
      .get()
    return row === undefined ? null : snapshot(row)
  }

  /** Internal utility for terminal control: exact tuple from a trusted token. */
  tuple(token: OwnershipToken): OwnershipTuple {
    return ownershipTuple(token)
  }
}
