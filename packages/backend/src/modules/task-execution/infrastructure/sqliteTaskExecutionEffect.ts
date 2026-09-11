import { and, desc, eq, max } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
} from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type {
  CodeHostAttemptPlan,
  LinkedWorkspaceRollbackEffect,
  TaskExecutionEffectStore,
} from './taskExecutionEffectTransactionStore'
import type { TaskOwnershipStore } from './taskOwnershipTransactionStore'
import { TaskExecutionError } from '../application/taskExecutionError'

export class SqliteTaskExecutionEffectStore implements TaskExecutionEffectStore {
  constructor(private readonly ownership: TaskOwnershipStore) {}

  linkWorkspaceRollbackTx(input: {
    tx: DbTxSync
    taskId: string
    intentId: string
    operationKey: string
    executionLineageId: string
    operationFamilyKey: string
    operationGeneration: number
    requestHash: string
    slotPathJson: string
    slotPathDigest: string
    now: number
  }): LinkedWorkspaceRollbackEffect {
    const intent = input.tx
      .select({
        taskId: taskExecutionIntents.taskId,
        kind: taskExecutionIntents.kind,
        state: taskExecutionIntents.state,
      })
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, input.intentId))
      .get()
    if (
      intent === undefined ||
      intent.taskId !== input.taskId ||
      intent.kind !== 'gate-continuation' ||
      intent.state !== 'pending'
    ) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `workspace rollback effect requires a pending gate continuation '${input.intentId}'`,
      )
    }
    const existing = input.tx
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.currentIntentId, input.intentId),
          eq(taskExecutionEffects.kind, 'workspace-rollback'),
        ),
      )
      .get()
    if (existing !== undefined) {
      if (
        existing.taskId !== input.taskId ||
        existing.operationKey !== input.operationKey ||
        existing.executionLineageId !== input.executionLineageId ||
        existing.operationFamilyKey !== input.operationFamilyKey ||
        existing.operationGeneration !== input.operationGeneration ||
        existing.requestHash !== input.requestHash ||
        existing.slotPathJson !== input.slotPathJson ||
        existing.slotPathDigest !== input.slotPathDigest
      ) {
        throw new TaskExecutionError(
          'task-continuation-conflict',
          `gate continuation '${input.intentId}' is already linked to another rollback effect`,
        )
      }
      return { effectId: existing.id, idempotent: true }
    }
    const effectId = ulid()
    input.tx
      .insert(taskExecutionEffects)
      .values({
        id: effectId,
        taskId: input.taskId,
        originIntentId: input.intentId,
        currentIntentId: input.intentId,
        operationKey: input.operationKey,
        executionLineageId: input.executionLineageId,
        operationFamilyKey: input.operationFamilyKey,
        operationGeneration: input.operationGeneration,
        kind: 'workspace-rollback',
        requestHash: input.requestHash,
        slotPathJson: input.slotPathJson,
        slotPathDigest: input.slotPathDigest,
        state: 'open',
        lastAttemptNo: 0,
        preparedAt: input.now,
        updatedAt: input.now,
      })
      .run()
    return { effectId, idempotent: false }
  }

  planCodeHostAttempt(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    executionLineageId: string
    operationFamilyKey: string
  }): CodeHostAttemptPlan {
    const highest = input.db
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .orderBy(desc(taskExecutionEffects.operationGeneration))
      .get()
    if (highest?.state === 'open') {
      const latestAttempt = input.db
        .select({
          state: taskExecutionEffectAttempts.state,
          retryAuthority: taskExecutionEffectAttempts.retryAuthority,
        })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.effectId, highest.id))
        .orderBy(desc(taskExecutionEffectAttempts.attemptNo))
        .get()
      if (latestAttempt?.state === 'retry-authorized' && latestAttempt.retryAuthority !== 'none') {
        return {
          operationGeneration: highest.operationGeneration,
          retryAuthority: latestAttempt.retryAuthority,
        }
      }
    }
    return {
      operationGeneration: this.nextOperationGeneration(input),
      retryAuthority: 'none',
    }
  }

  nextOperationGeneration(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    executionLineageId: string
    operationFamilyKey: string
  }): number {
    const liveHighest = input.db
      .select({ generation: max(taskExecutionEffects.operationGeneration) })
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .get()?.generation
    const watermark = input.db
      .select({ generation: taskExecutionLineageOperationRecords.highestSettledGeneration })
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .get()?.generation
    return Math.max(liveHighest ?? -1, watermark ?? -1) + 1
  }

  // RFC-359 W10 —— 同步的 `closeOutcomeUnknownAndRelease`（一笔 `dbTxSync`：owner 围栏 +
  // 未决效应集合逐项 outcome-unknown + 生成 replay 决定 + 释放 owner）已删除。它自 W1-T7b 起
  // 就没有生产调用方——driver 释放序列（`taskDriverRelease.ts`）走的是端口，落到两个引擎共用的
  // `effectQuiescence.ts#closeOutcomeUnknownAndRelease`（中立事务 + `lockAndAssertOwnerTx`）；
  // 留着的只有三处测试直调，已改指中立那份。
}
