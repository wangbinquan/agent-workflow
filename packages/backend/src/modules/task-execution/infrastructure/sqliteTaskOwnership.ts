// RFC-359 W8 —— bun:sqlite 专属的**同步**归属 store。
//
// 归属端口本身已经合一（`taskOwnershipPersistence.ts`，一份实现两个引擎共用）。这里剩下的
// 只为那些签名钉死在 `DbTxSync` 上的参与者与它们的同步调用方服务：
//   · `withOwnedTaskTx` —— 回调签名是 `(tx: DbTxSync, owned: OwnedTaskTx) => T`。W10 之后
//     src 侧只剩 2 处调用点（`sqliteTaskExecutionEffect.ts` 的 `prepareAndAcquire` / `settle`）
//     加上 `platform/persistence/sqlite/taskLifecycle.ts` 的 `setTaskStatus`；
//   · `revokeExactTx` —— `services/task.ts` 传给 `setTaskStatus` 的 `onTransitionTx` 回调在那笔
//     还没转的同步事务里当参与者调用。它的中立对等物是
//     `taskOwnershipPersistence.ts#revokeExactOwnerInTx`，源终止参与者用的就是那份；
//   · `claimPendingIntent` —— `taskExecutionModule.claim` → `taskDriverLifecycle.ts` 的同步认领。
// `releaseAfterStop` / `releaseRecovered` / `revokeOldDaemon` 已随 W8 合一删除：它们唯一的
// 调用方（合一前的 SQLite 恢复流程与 43 行端口适配器）都没有了。RFC-359 W10 又去掉了
// `revokeExact` 的事务包装（单语句 CAS 本就原子，理由写在该方法上）。

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  taskExecutionIntents,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
} from '@/db/schema'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import type { TaskOwnershipStore } from './taskOwnershipTransactionStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  assertOwnershipToken,
  assertWorkerIdentity,
  createOwnedTaskTx,
  createOwnershipToken,
  decideOwnerTransition,
  ownershipTuple,
  refreshOwnershipToken,
  type OwnedTaskTx,
  type OwnerSnapshot,
  type OwnershipToken,
  type OwnershipTuple,
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

  /**
   * RFC-359 W10 —— 事务包装去掉了。体内是**一条** `UPDATE … WHERE (精确 owner 元组 + 期望
   * revision + state='claimed') RETURNING *`：单语句在两个引擎上本来就是原子的，赢/输由 CAS
   * 判据自己裁决（没命中就 `.get()` 回 undefined，抛 stale-owner），外面再套一层 `BEGIN` /
   * `COMMIT` 不改变任何可观测行为，只是把这条路径钉死在 bun:sqlite 专属的同步事务面上。
   * 中立孪生 `taskOwnershipPersistence.ts` 的 `revokeExact` 早就是这个形状（无事务的单语句
   * CAS），这里与它对齐。要把撤销和别的写并成一笔的调用方走 `revokeExactTx`，把自己的事务
   * 句柄传进来。
   */
  revokeExact(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    now: number
    recoveryCode?: string
  }): OwnerSnapshot {
    return this.revokeExactTx({
      tx: input.db,
      owner: input.owner,
      expectedRevision: input.expectedRevision,
      now: input.now,
      ...(input.recoveryCode !== undefined ? { recoveryCode: input.recoveryCode } : {}),
    })
  }

  revokeExactTx(input: {
    /** 事务句柄，或连接本身（单语句 CAS 时的同一套同步面）。 */
    tx: DbTxSync | DbClient
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
