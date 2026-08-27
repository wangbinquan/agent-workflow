// RFC-333 — task-execution's offered, transaction-bound gate decision participant.

import { and, eq, inArray } from '@/db/query'
import { nodeRuns, taskExecutionIntents } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { HumanGateIdentity } from '@/modules/collaboration/public/types'
import { ulid } from 'ulid'
import { taskExecutionModule } from '../composition'
import { sha256Hex } from '../domain/digest'
import { operationFamilyKey } from '../domain/executionEffect'
import { decodeLineageSlotPath } from '../domain/executionIntent'
import {
  canonicalHumanGateContinuationLineage,
  humanGateNodeProjectionFence,
  type HumanGateContinuationLineage,
  type HumanGateNodeProjectionFence,
  type HumanGateNodeProjectionMember,
  type HumanGateWorkspaceRollbackRef,
} from '../domain/humanGateContinuation'
import type { TaskExecutionEffectStore } from './ports/taskExecutionEffectStore'
import type { HumanGateTaskLifecycle } from './ports/humanGateTaskLifecycle'
import { submitTaskContinuationTx } from './submitTaskContinuation'
import { TaskExecutionError } from './taskExecutionError'

export interface AcceptHumanGateDecisionInput {
  readonly taskId: string
  readonly gate: HumanGateIdentity
  readonly expectedTaskRevision: number
  readonly expectedNodeProjection: HumanGateNodeProjectionFence
  readonly continuationLineage: HumanGateContinuationLineage
  readonly workspaceRollbackPlan?: HumanGateWorkspaceRollbackRef
  readonly operationId: string
  readonly now: number
}

export interface AcceptedHumanGateDecision {
  readonly taskRevision: number
  readonly continuationRef: string
}

export interface TaskDecisionParticipantInTx {
  acceptGateDecisionTx(input: AcceptHumanGateDecisionInput): AcceptedHumanGateDecision
}

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

function assertProjection(input: {
  tx: DbTxSync
  taskId: string
  expected: HumanGateNodeProjectionFence
  lineage: HumanGateContinuationLineage
}): HumanGateContinuationLineage {
  const lineage = canonicalHumanGateContinuationLineage(input.lineage)
  const ids = [...lineage.sourceNodeRunIds, ...lineage.rerunNodeRunIds]
  const rows =
    ids.length === 0 ? [] : input.tx.select().from(nodeRuns).where(inArray(nodeRuns.id, ids)).all()
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

export class SqliteTaskDecisionParticipantInTx implements TaskDecisionParticipantInTx {
  constructor(
    private readonly tx: DbTxSync,
    private readonly lifecycle: Pick<HumanGateTaskLifecycle, 'transitionTx'>,
    private readonly effects: TaskExecutionEffectStore = taskExecutionModule.effects,
  ) {}

  acceptGateDecisionTx(input: AcceptHumanGateDecisionInput): AcceptedHumanGateDecision {
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
    const continuationLineage = assertProjection({
      tx: this.tx,
      taskId: input.taskId,
      expected: input.expectedNodeProjection,
      lineage: input.continuationLineage,
    })
    const transition = this.lifecycle.transitionTx({
      tx: this.tx,
      taskId: input.taskId,
      expectedTaskRevision: input.expectedTaskRevision,
      transition: input.gate.kind === 'review' ? 'release-review' : 'release-human',
      now: input.now,
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
    const submitted = submitTaskContinuationTx(this.tx, {
      taskId: input.taskId,
      intentId: ulid(),
      kind: 'gate-continuation',
      source: 'internal',
      actorUserId: null,
      payload,
      now: input.now,
      advanceOperationGeneration: false,
    })

    if (input.workspaceRollbackPlan !== undefined) {
      const intent = this.tx
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
      this.effects.linkWorkspaceRollbackTx({
        tx: this.tx,
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
    }
  }
}

export function bindTaskDecisionParticipantInTx(
  tx: DbTxSync,
  lifecycle: Pick<HumanGateTaskLifecycle, 'transitionTx'>,
  effects?: TaskExecutionEffectStore,
): TaskDecisionParticipantInTx {
  return new SqliteTaskDecisionParticipantInTx(tx, lifecycle, effects)
}
