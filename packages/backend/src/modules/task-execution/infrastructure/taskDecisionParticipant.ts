// RFC-359 —— human-gate 决定的接受原子：一份实现，两个引擎。
//
// 投影围栏复核 → 任务生命周期释放 → 后继 continuation 准入 → 可选的 workspace-rollback 效果
// 挂接，四步在调用方的一笔事务里提交或一起回滚。此前 SQLite 侧是 `sqliteTaskDecisionParticipant.ts`
// （同步，过渡期保留给同步调用方），PostgreSQL 侧是 `postgresqlTaskDecisionPersistence.ts`
// （每次自开 SERIALIZABLE 事务）；两份逻辑逐字相同，这里是唯一的 async 版本。
//
// `DatabaseTaskDecisionPersistence` 是两个 provider 共用的 db-owning 端口实现：每次调用自开
// 一笔 `session.transaction`，先锁任务聚合根（PostgreSQL：`FOR UPDATE`，同任务的决定串行；
// SQLite：独占事务，no-op），再走上面的原子。

import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import { nodeRuns, taskExecutionIntents, tasks } from '@/db/schema'
import { committedEventGroupId } from '@/platform/events/committed/types'
import {
  engineOf,
  type DatabaseSession,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type {
  AcceptHumanGateDecisionInput,
  AcceptedHumanGateDecision,
  HumanGateDecisionPersistence,
} from '../application/acceptHumanGateDecision'
import { TaskExecutionError } from '../application/taskExecutionError'
import { sha256Hex } from '../domain/digest'
import { operationFamilyKey } from '../domain/executionEffect'
import { decodeLineageSlotPath } from '../domain/executionIntent'
import {
  canonicalHumanGateContinuationLineage,
  humanGateNodeProjectionFence,
  type HumanGateContinuationLineage,
  type HumanGateNodeProjectionFence,
  type HumanGateNodeProjectionMember,
} from '../domain/humanGateContinuation'
import { transitionHumanGateTask } from './humanGateTaskTransition'
import { submitTaskContinuation } from './taskContinuationAdmission'
import { linkWorkspaceRollbackEffect } from './workspaceRollbackEffect'

function projectionMember(row: typeof nodeRuns.$inferSelect): HumanGateNodeProjectionMember {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    reviewIteration: row.reviewIteration,
    status: row.status,
    failureCode: row.failureCode,
    preSnapshot: row.preSnapshot,
    preSnapshotReposJson: row.preSnapshotReposJson,
    rerunCause: row.rerunCause,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
  }
}

function assertInput(input: AcceptHumanGateDecisionInput): void {
  if (
    input.taskId.length === 0 ||
    input.gate.ref.length === 0 ||
    input.operationId.length === 0 ||
    !Number.isSafeInteger(input.expectedTaskRevision) ||
    input.expectedTaskRevision < 0 ||
    !Number.isSafeInteger(input.now)
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'human-gate decision participant received invalid identity or revision input',
    )
  }
  if (
    input.workspaceRollbackPlan !== undefined &&
    input.workspaceRollbackPlan.operationId !== input.operationId
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'workspace rollback plan is not bound to this human-gate operation',
    )
  }
}

async function assertProjection(
  tx: DatabaseTransaction,
  input: {
    taskId: string
    expected: HumanGateNodeProjectionFence
    lineage: HumanGateContinuationLineage
  },
): Promise<HumanGateContinuationLineage> {
  const lineage = canonicalHumanGateContinuationLineage(input.lineage)
  const ids = [...lineage.sourceNodeRunIds, ...lineage.rerunNodeRunIds]
  const rows =
    ids.length === 0
      ? []
      : await tx.select().from(nodeRuns).where(inArray(nodeRuns.id, ids)).limit(ids.length)
  if (
    rows.length !== ids.length ||
    rows.some((row) => row.taskId !== input.taskId) ||
    input.expected.memberCount !== ids.length
  ) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `human-gate node projection changed for task '${input.taskId}'`,
    )
  }
  const actual = humanGateNodeProjectionFence(rows.map(projectionMember))
  if (
    actual.memberCount !== input.expected.memberCount ||
    actual.digest !== input.expected.digest
  ) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `human-gate node projection digest changed for task '${input.taskId}'`,
      { expectedDigest: input.expected.digest, currentDigest: actual.digest },
    )
  }
  return lineage
}

/** 在调用方已持有的事务里接受一个 human-gate 决定。 */
export async function acceptHumanGateDecisionTx(
  tx: DatabaseTransaction,
  input: AcceptHumanGateDecisionInput,
): Promise<AcceptedHumanGateDecision> {
  assertInput(input)
  const continuationLineage = await assertProjection(tx, {
    taskId: input.taskId,
    expected: input.expectedNodeProjection,
    lineage: input.continuationLineage,
  })
  const transition = await transitionHumanGateTask(tx, {
    taskId: input.taskId,
    expectedTaskRevision: input.expectedTaskRevision,
    transition: input.gate.kind === 'review' ? 'release-review' : 'release-human',
    now: input.now,
    ...(input.nodeChanges === undefined ? {} : { nodeChanges: input.nodeChanges }),
    committedEventIdentity: {
      operationRef: input.operationId,
      eventGroupId: committedEventGroupId('collaboration', input.operationId),
      eventGroupOrdinal: 0,
    },
  })
  const payload = {
    v: 1 as const,
    gate: { kind: input.gate.kind, ref: input.gate.ref },
    operationId: input.operationId,
    expectedNodeProjection: input.expectedNodeProjection,
    continuationLineage,
    ...(input.workspaceRollbackPlan === undefined
      ? {}
      : { workspaceRollbackPlan: input.workspaceRollbackPlan }),
  }
  const submitted = await submitTaskContinuation(tx, {
    taskId: input.taskId,
    intentId: ulid(),
    kind: 'gate-continuation',
    source: 'internal',
    actorUserId: null,
    payload,
    now: input.now,
    advanceOperationGeneration: false,
    // A visible gate may be decided while a previously admitted sibling is still settling.
    // Keep one claimed owner and admit exactly one durable successor; the old owner hands off
    // before dispatching any new work.
    admissionMode: 'successor-after-claimed',
  })

  if (input.workspaceRollbackPlan !== undefined) {
    const intent = await tx
      .select({
        executionLineageId: taskExecutionIntents.executionLineageId,
        continuationSlotKey: taskExecutionIntents.continuationSlotKey,
        slotPathJson: taskExecutionIntents.slotPathJson,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.id, submitted.intentId),
          eq(taskExecutionIntents.taskId, input.taskId),
        ),
      )
      .get()
    if (intent === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `gate continuation '${submitted.intentId}' disappeared before effect linking`,
      )
    }
    const slotPath = decodeLineageSlotPath(intent.slotPathJson)
    const stableActionOrdinal = `human-gate:${input.operationId}`
    await linkWorkspaceRollbackEffect(tx, {
      taskId: input.taskId,
      intentId: submitted.intentId,
      operationKey: `${intent.continuationSlotKey}:workspace-rollback:${stableActionOrdinal}`,
      executionLineageId: intent.executionLineageId,
      operationFamilyKey: operationFamilyKey({
        executionLineageId: intent.executionLineageId,
        slotPath,
        effectKind: 'workspace-rollback',
        stableActionOrdinal,
      }),
      operationGeneration: 0,
      requestHash: input.workspaceRollbackPlan.planDigest,
      slotPathJson: intent.slotPathJson,
      slotPathDigest: sha256Hex(intent.slotPathJson),
      now: input.now,
    })
  }

  return {
    taskRevision: transition.taskRevision,
    continuationRef: submitted.intentId,
    eventRefs: transition.eventRefs,
  }
}

export class DatabaseTaskDecisionPersistence implements HumanGateDecisionPersistence {
  constructor(private readonly session: DatabaseSession) {}

  async accept(input: AcceptHumanGateDecisionInput): Promise<AcceptedHumanGateDecision> {
    assertInput(input)
    return await this.session.transaction(async (tx) => {
      await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, input.taskId)
      return await acceptHumanGateDecisionTx(tx, input)
    })
  }
}
