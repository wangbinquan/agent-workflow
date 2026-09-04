// RFC-359 —— 把 workspace-rollback 效果挂到已准入的 gate continuation 上：一份实现，两个引擎。
// 逻辑与 `sqliteTaskExecutionEffect.ts` 的 `linkWorkspaceRollbackTx` / 此前 PostgreSQL 侧的
// `linkPostgresqlWorkspaceRollbackEffectTx` 逐字相同，这里是唯一的 async 版本。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { taskExecutionEffects, taskExecutionIntents } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { TaskExecutionError } from '../application/taskExecutionError'

export type LinkWorkspaceRollbackEffectInput = Readonly<{
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
}>

export type LinkedWorkspaceRollbackEffect = Readonly<{ effectId: string; idempotent: boolean }>

export async function linkWorkspaceRollbackEffect(
  tx: DatabaseTransaction,
  input: LinkWorkspaceRollbackEffectInput,
): Promise<LinkedWorkspaceRollbackEffect> {
  const intent = await tx
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
  const existing = await tx
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
  await tx
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
