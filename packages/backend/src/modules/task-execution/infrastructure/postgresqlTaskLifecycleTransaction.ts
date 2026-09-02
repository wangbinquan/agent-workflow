// RFC-349 — PostgreSQL task lifecycle primitives used only by named
// task-execution atoms. They intentionally expose a provider-private
// transaction type, never a callback through an application/public port.

import {
  allowedFromForTaskEvent,
  targetForTaskEvent,
  type TaskStatus,
  type TaskTransitionEvent,
} from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'

import { taskExecutionOwners, tasks } from '@/db/schema'
import {
  appendPostgresqlCommittedEventTx,
  type PostgresqlCommittedEventTransaction,
} from '@/platform/events/committed/postgresqlPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { committedEventGroupId } from '@/platform/events/committed/types'
import { taskLifecycleDurableConsumers } from '../domain/taskLifecycleCommittedEvent'
import type {
  TaskLifecycleTransitionedPayloadV1,
  TaskNodeChangeV1,
  TaskNodeStatusesTransitionedPayloadV1,
} from '../domain/taskLifecycleCommittedEvent'
import { assertOwnershipToken, type OwnershipToken } from '../domain/ownership'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { TaskExecutionError } from '../application/taskExecutionError'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

export type PostgresqlTaskExecutionTransaction = PostgresqlCommittedEventTransaction

export type PostgresqlTaskCommittedEventIdentity = Readonly<{
  operationRef: string
  eventGroupId?: string
  eventGroupOrdinal?: number
  correlationRef?: string | null
  causationRef?: string | null
}>

export type PostgresqlHumanGateTaskTransition =
  | 'park-review'
  | 'park-human'
  | 'release-review'
  | 'release-human'

export async function withPostgresqlSerializableTaskExecution<T>(
  db: PostgresqlDatabaseClient,
  body: (tx: PostgresqlTaskExecutionTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

/**
 * RFC-349 —— 单聚合的「读—改—写」事务：不走 SERIALIZABLE，改为在聚合根（task 行）上
 * 取排他行锁。
 *
 * 为什么换：SERIALIZABLE 对「先按 task_id 读一遍、再 delete 同一批、再 insert 回去」这种
 * 形状会大量误判。predicate lock 的粒度是**索引页**而不是行，于是两个改**不同任务**的事务
 * 只要 btree 页相邻就互判读写依赖。2026-09-03 对着真 PostgreSQL 的合成实验（10 万行、
 * 32 并发、逐项排除）：
 *
 *   基线（SERIALIZABLE）                       冲突率 22.9%
 *   去掉 generation fence 那次读                    23.1%   ← 不是 fence
 *   读改成整主键精确命中                            22.7%   ← 不是读的形状
 *   删掉 user 索引 / 每个任务换不同 user      22.5% / 22.7%  ← 不是热点用户
 *   去掉 insert（只 delete）                         0%     ← 冲突来自 delete+insert 这一对
 *   **READ COMMITTED + 聚合根 FOR UPDATE**           0.0%
 *
 * 而重试预算填不平这件事：取证门同时要求 `httpErrors === 0` 与单请求 < 1000ms，加重试只会
 * 把尾延迟推高（托管 2 核上已经量到 `API max 1066.8ms`）。
 *
 * 为什么安全：这条路径的不变量本来就是**每任务**的——它读的 `tasks.owner_user_id` 与
 * `task_collaborators` 都属于同一个任务，锁住任务行就把同一任务的并发写手串起来了，
 * 而不同任务之间本来就没有需要串行化的不变量。**只有满足这个条件的路径才可以用它**：
 * 事务读写的行全部属于同一个聚合根，且判据不依赖聚合之外的快照。跨聚合的不变量
 * （跨表计数、全局唯一性）仍然必须留在 `withPostgresqlSerializableTaskExecution` 上。
 *
 * 任务行不存在时不取锁：调用方自己的 NotFound 判据仍然成立（没有行就没有要保护的聚合）。
 */
export async function withPostgresqlTaskAggregateTransaction<T>(
  db: PostgresqlDatabaseClient,
  taskId: string,
  body: (tx: PostgresqlTaskExecutionTransaction) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.run(sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${taskId} for update`)
    return await body(tx)
  })
}

export async function assertPostgresqlTaskOwnerTx(
  tx: PostgresqlTaskExecutionTransaction,
  token: OwnershipToken,
  now: number,
): Promise<void> {
  assertOwnershipToken(token)
  // Match SQLite's withOwnedTaskTx fence: the immutable capability names the
  // exact owner identity + epoch, while revision is advanced for every atomic
  // mutation. Heartbeats may already have advanced revision after this token
  // was minted, so revision/lease snapshots are deliberately not equality
  // predicates here.
  const rows = await tx
    .update(taskExecutionOwners)
    .set({
      revision: sql`${taskExecutionOwners.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(taskExecutionOwners.taskId, token.taskId),
        eq(taskExecutionOwners.ownerId, token.ownerId),
        eq(taskExecutionOwners.daemonGeneration, token.daemonGeneration),
        eq(taskExecutionOwners.epoch, token.epoch),
        eq(taskExecutionOwners.state, 'claimed'),
      ),
    )
    .returning({ revision: taskExecutionOwners.revision })
  if (rows[0] === undefined) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `task '${token.taskId}' mutation was fenced`,
    )
  }
}

export async function assertPostgresqlTaskOwnerlessTx(
  tx: PostgresqlTaskExecutionTransaction,
  taskId: string,
): Promise<void> {
  const rows = await tx
    .select({ state: taskExecutionOwners.state })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, taskId))
    .limit(1)
  if (rows[0] !== undefined && rows[0].state !== 'released') {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `ownerless task mutation refused durable owner for '${taskId}'`,
    )
  }
}

export async function appendPostgresqlTaskCreatedTx(
  tx: PostgresqlTaskExecutionTransaction,
  input: Readonly<{
    taskId: string
    status: 'pending' | 'failed'
    errorSummary: string | null
    occurredAt: number
    identity?: Partial<PostgresqlTaskCommittedEventIdentity>
  }>,
): Promise<TaskExecutionPostCommitEventRef | null> {
  const operationRef = input.identity?.operationRef ?? `task-lifecycle:${input.taskId}:1`
  const receipt = await appendPostgresqlCommittedEventTx(tx, {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.created.v1',
    aggregate: { kind: 'task', id: input.taskId, seq: 1 },
    eventId: `task-lifecycle:${input.taskId}:1`,
    operationRef,
    eventGroupId:
      input.identity?.eventGroupId ?? committedEventGroupId('task-execution', operationRef),
    eventGroupOrdinal: input.identity?.eventGroupOrdinal ?? 0,
    correlationRef: input.identity?.correlationRef ?? null,
    causationRef: input.identity?.causationRef ?? null,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      lifecycleRevision: 1 as const,
      previousStatus: null,
      status: input.status,
      createdAt: new Date(input.occurredAt).toISOString(),
      errorSummary: input.errorSummary,
    },
    consumers: taskLifecycleDurableConsumers('task.created.v1'),
  })
  return receipt.eventRef
}

export async function appendPostgresqlTaskLifecycleTransitionTx(
  tx: PostgresqlTaskExecutionTransaction,
  input: Readonly<{
    taskId: string
    lifecycleRevision: number
    previousStatus: TaskStatus
    status: TaskStatus
    errorSummary: string | null
    nodeChanges?: readonly TaskNodeChangeV1[]
    workspacePruneClaim?: TaskLifecycleTransitionedPayloadV1['workspacePruneClaim']
    sourceTerminationEffectRef?: string | null
    occurredAt: number
    identity?: Partial<PostgresqlTaskCommittedEventIdentity>
  }>,
): Promise<TaskExecutionPostCommitEventRef | null> {
  const operationRef =
    input.identity?.operationRef ?? `task-lifecycle:${input.taskId}:${input.lifecycleRevision}`
  const receipt = await appendPostgresqlCommittedEventTx(tx, {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.lifecycle-transitioned.v1',
    aggregate: { kind: 'task', id: input.taskId },
    eventId: `task-lifecycle:${input.taskId}:${input.lifecycleRevision}`,
    operationRef,
    eventGroupId:
      input.identity?.eventGroupId ?? committedEventGroupId('task-execution', operationRef),
    eventGroupOrdinal: input.identity?.eventGroupOrdinal ?? 0,
    correlationRef: input.identity?.correlationRef ?? null,
    causationRef: input.identity?.causationRef ?? null,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      lifecycleRevision: input.lifecycleRevision,
      previousStatus: input.previousStatus,
      status: input.status,
      updatedAt: new Date(input.occurredAt).toISOString(),
      errorSummary: input.errorSummary,
      nodeChanges: input.nodeChanges ?? [],
      workspacePruneClaim: input.workspacePruneClaim ?? null,
      sourceTerminationEffectRef: input.sourceTerminationEffectRef ?? null,
    },
    consumers: taskLifecycleDurableConsumers('task.lifecycle-transitioned.v1'),
  })
  return receipt.eventRef
}

export async function appendPostgresqlTaskNodeStatusesTx(
  tx: PostgresqlTaskExecutionTransaction,
  input: Readonly<{
    taskId: string
    reason?: TaskNodeStatusesTransitionedPayloadV1['reason']
    nodeChanges: readonly TaskNodeChangeV1[]
    occurredAt: number
    identity: PostgresqlTaskCommittedEventIdentity
  }>,
): Promise<TaskExecutionPostCommitEventRef | null> {
  const operationRef = input.identity.operationRef
  const receipt = await appendPostgresqlCommittedEventTx(tx, {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.node-statuses-transitioned.v1',
    aggregate: { kind: 'task', id: input.taskId },
    operationRef,
    eventGroupId:
      input.identity.eventGroupId ?? committedEventGroupId('task-execution', operationRef),
    eventGroupOrdinal: input.identity.eventGroupOrdinal ?? 0,
    correlationRef: input.identity.correlationRef ?? null,
    causationRef: input.identity.causationRef ?? null,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      reason: input.reason ?? 'source-termination',
      nodeChanges: input.nodeChanges,
      updatedAt: new Date(input.occurredAt).toISOString(),
    },
    consumers: taskLifecycleDurableConsumers('task.node-statuses-transitioned.v1'),
  })
  return receipt.eventRef
}

export async function transitionPostgresqlHumanGateTaskTx(
  tx: PostgresqlTaskExecutionTransaction,
  input: Readonly<{
    taskId: string
    expectedTaskRevision: number
    transition: PostgresqlHumanGateTaskTransition
    now: number
    nodeChanges?: readonly TaskNodeChangeV1[]
    committedEventIdentity?: Partial<PostgresqlTaskCommittedEventIdentity>
  }>,
): Promise<{
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly taskRevision: number
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}> {
  const rows = await tx
    .select({
      status: tasks.status,
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      errorSummary: tasks.errorSummary,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new TaskExecutionError('task-continuation-stale', `task '${input.taskId}' not found`)
  }
  if (row.lifecycleEventRevision !== input.expectedTaskRevision) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `human-gate revision changed for task '${input.taskId}'`,
      {
        expectedRevision: input.expectedTaskRevision,
        currentRevision: row.lifecycleEventRevision,
      },
    )
  }
  if (
    (input.transition === 'park-review' && row.status === 'awaiting_review') ||
    (input.transition === 'park-human' && row.status === 'awaiting_human')
  ) {
    return {
      from: row.status,
      to: row.status,
      taskRevision: row.lifecycleEventRevision,
      eventRefs: [],
    }
  }

  const event: TaskTransitionEvent =
    input.transition === 'park-review'
      ? { kind: 'park-review' }
      : input.transition === 'park-human'
        ? { kind: 'park-human' }
        : { kind: 'resume' }
  const expectedFrom: readonly TaskStatus[] =
    input.transition === 'release-review'
      ? ['awaiting_review']
      : input.transition === 'release-human'
        ? ['awaiting_human']
        : allowedFromForTaskEvent(event)
  const from = row.status as TaskStatus
  if (!expectedFrom.includes(from)) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      `task '${input.taskId}' status '${from}' cannot ${input.transition}`,
    )
  }
  const to = targetForTaskEvent(event)
  const updated = await tx
    .update(tasks)
    .set({
      status: to,
      ...(to === 'running'
        ? { runningSince: input.now }
        : from === 'running'
          ? {
              runningMs: sql`${tasks.runningMs} + (${input.now} - COALESCE(${tasks.runningSince}, ${input.now}))`,
              runningSince: null,
            }
          : {}),
      ...(input.transition === 'release-review' || input.transition === 'release-human'
        ? {
            finishedAt: null,
            errorSummary: null,
            errorMessage: null,
            failedNodeId: null,
          }
        : {}),
      lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, from),
        eq(tasks.lifecycleEventRevision, input.expectedTaskRevision),
      ),
    )
    .returning({ lifecycleEventRevision: tasks.lifecycleEventRevision })
  const changed = updated[0]
  if (changed === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `human-gate lifecycle CAS lost for task '${input.taskId}'`,
    )
  }
  const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
    taskId: input.taskId,
    lifecycleRevision: changed.lifecycleEventRevision,
    previousStatus: from,
    status: to,
    errorSummary:
      input.transition === 'release-review' || input.transition === 'release-human'
        ? null
        : row.errorSummary,
    ...(input.nodeChanges === undefined ? {} : { nodeChanges: input.nodeChanges }),
    occurredAt: input.now,
    ...(input.committedEventIdentity === undefined
      ? {}
      : { identity: input.committedEventIdentity }),
  })
  return {
    from,
    to,
    taskRevision: changed.lifecycleEventRevision,
    eventRefs: eventRef === null ? [] : [eventRef],
  }
}
