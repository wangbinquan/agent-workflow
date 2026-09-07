// RFC-359 W8 —— 任务归属（durable ownership）端口的**一份**实现，两个引擎共用。
//
// 此前是 D28a 记下的那对：SQLite 侧 43 行薄适配器套 `sqliteTaskOwnership.ts` 里 563 行同步实现
// （dbTxSync 家族），PostgreSQL 侧 444 行原生重写。两侧逐方法比对下来只有一条真差异，
// 由 `rfc359-w8-task-execution-recovery-conformance.test.ts` ⑤ 实测照出：
//
//   · 08-pg-release-recovered-replay-decision-rollback —— SQLite 的 `releaseRecovered` 走
//     `terminalizeTaskExecutionIntentsTx`，会把绑在被中断 intent 上、尚未消费的
//     `actor-replay-authorized` 决策退回 `requires-actor`；PG 侧只 inline 改了 intent 行，
//     重放授权悬空。合一按强侧（SQLite）抬齐：这里调用中立的
//     `terminalizeTaskExecutionIntentsInTx`，缺口关闭。
//
// 同步事务面：`sqliteTaskOwnership.ts` 仍留着 bun:sqlite 专属的同步 store，但只为那些**签名
// 钉死在 `DbTxSync` 上**的参与者（`withOwnedTaskTx` 的回调、`revokeExactTx`）与它们的调用方
// （`services/task.ts` 的 `onTransitionTx`、`platform/persistence/sqlite/taskLifecycle.ts`、
// `taskDriverLifecycle.ts` 的同步认领）服务。端口这一侧不再经它——`releaseAfterStop` /
// `releaseRecovered` / `revokeOldDaemon` 已从同步 store 删除（W8），`revokeExact` 的事务包装也在
// W10 去掉（单语句 CAS 本就原子），同步事务面因此 5 → 3 → 2
// （账本 `rfc359-sync-transaction-highwater.test.ts`）。

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
} from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
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
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'

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

/** 任务还剩没结算的 attempt 或没释放的资源占用 —— owner 不能干净让出。 */
async function hasUnresolvedEffects(tx: DatabaseTransaction, taskId: string): Promise<boolean> {
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

/**
 * RFC-359 W10 —— 撤销**精确** owner 元组的事务内参与者。
 *
 * 判据是一条 `UPDATE … WHERE (taskId + ownerId + 世代 + epoch + 期望 revision + state='claimed')
 * RETURNING *`：单语句自带原子性，赢/输由 CAS 自己裁决，所以它既能独立跑（`revokeExact` 直接把
 * 客户端当句柄传进来），也能被更大的原子在自己的事务里调用（源终止把「围栏 + 撤销 owner +
 * intent 终态化 + node_run 取消」并成一笔）。合一前后者只有 bun:sqlite 专属的同步孪生
 * `sqliteTaskOwnership.ts#revokeExactTx` 一条路，PostgreSQL 侧只能在
 * `postgresqlSourceTerminationParticipant.ts` 里再抄一份 inline CAS。
 */
export async function revokeExactOwnerInTx(
  tx: DatabaseTransaction,
  input: {
    readonly owner: Readonly<{
      taskId: string
      ownerId: string
      daemonGeneration: string
      epoch: number
    }>
    readonly expectedRevision: number
    readonly now: number
    readonly recoveryCode?: string | undefined
  },
): Promise<OwnerSnapshot> {
  const row = (
    await tx
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
  )[0]
  if (row === undefined) throw stale(`task '${input.owner.taskId}' revoke lost`)
  return snapshot(row)
}

/** provider 中立的归属 / CAS / 租约边界：原子迁移各有其名，库句柄与事务作用域都不外泄。 */
export class DrizzleTaskOwnershipPersistence implements TaskOwnershipPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async claimPendingIntent(input: Parameters<TaskOwnershipPersistence['claimPendingIntent']>[0]) {
    assertWorkerIdentity(input.identity)
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('ownership lease must be positive')
    }
    // 每任务至多一个活跃 owner / 每任务至多一条 pending·claimed intent 都是跨行谓词，沿用 SERIALIZABLE。
    const claimed = await databaseSessionFor(this.db).serializable(async (tx) => {
      const intent = (
        await tx
          .select({
            id: taskExecutionIntents.id,
            taskId: taskExecutionIntents.taskId,
            state: taskExecutionIntents.state,
          })
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, input.intentId))
          .limit(1)
      )[0]
      if (intent === undefined || intent.state !== 'pending') {
        throw new TaskExecutionError(
          'task-execution-owner-conflict',
          `intent '${input.intentId}' is not pending`,
        )
      }
      const maintenance = (
        await tx
          .select({ claimId: taskExecutionMaintenanceMembers.claimId })
          .from(taskExecutionMaintenanceMembers)
          .where(
            and(
              eq(taskExecutionMaintenanceMembers.taskId, intent.taskId),
              isNull(taskExecutionMaintenanceMembers.releasedAt),
            ),
          )
          .limit(1)
      )[0]
      if (maintenance !== undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${intent.taskId}' is claimed by terminal maintenance`,
          { claimRef: maintenance.claimId },
        )
      }

      const old = (
        await tx
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, intent.taskId))
          .limit(1)
      )[0]
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
        const updated = await tx
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
        if (updated[0] === undefined) throw stale(`task '${intent.taskId}' owner claim lost`)
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
        .returning({ id: taskExecutionIntents.id })
      if (intentClaim[0] === undefined) throw stale(`intent '${input.intentId}' claim lost`)
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
    const row = (
      await this.db
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
    )[0]
    if (row === undefined) throw stale(`task '${input.token.taskId}' heartbeat was fenced`)
    // 心跳返回一份新的不可变 token 快照：归属身份 / epoch 不变，调用方可以原子替换自己那份。
    return refreshOwnershipToken({
      token: input.token,
      leaseUntil: row.leaseUntil,
      ownerRevision: row.revision,
    })
  }

  async revokeExact(input: Parameters<TaskOwnershipPersistence['revokeExact']>[0]) {
    // 单语句 CAS：没有事务包装，客户端本身就是句柄（见 `revokeExactOwnerInTx` 头注释）。
    return await revokeExactOwnerInTx(this.db, input)
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
    const row = (
      await this.db
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
    )[0]
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
    return await databaseSessionFor(this.db).serializable(async (tx) => {
      // 已被授权重试的 open effect 是持久续跑点、不是还在动作的写者：它的资源占用在同一笔结算
      // 事务里已经释放。owner 可以让出，下一次合法续跑再做那次已授权的同代重试。
      // prepared / acting / recovery-required 的 attempt 与任何幸存的占用仍然挡住释放。
      if (await hasUnresolvedEffects(tx, input.token.taskId)) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `task '${input.token.taskId}' still has unresolved effects or resource holds`,
        )
      }
      const row = (
        await tx
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
      )[0]
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
    return await databaseSessionFor(this.db).serializable(async (tx) => {
      if (await hasUnresolvedEffects(tx, input.owner.taskId)) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `task '${input.owner.taskId}' still has unresolved effects`,
        )
      }
      // 缺口 08：被中断的那一代 intent 转 failed 的同时，绑在它上面、尚未消费的重放授权
      // 必须退回 requires-actor —— 否则接管之后授权悬空。
      await terminalizeTaskExecutionIntentsInTx(tx, {
        taskId: input.owner.taskId,
        state: 'failed',
        failureCode: 'daemon-restart-recovered',
        now: input.now,
        claimedOwnerEpoch: input.owner.epoch,
      })
      const row = (
        await tx
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
      )[0]
      if (row === undefined) throw stale(`task '${input.owner.taskId}' recovery release lost`)
      return snapshot(row)
    })
  }

  async read(taskId: string) {
    const row = (
      await this.db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, taskId))
        .limit(1)
    )[0]
    return row === undefined ? null : snapshot(row)
  }
}
