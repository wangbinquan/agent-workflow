// RFC-349 — PostgreSQL human-gate decision atom. Projection fencing, task
// lifecycle release, successor intent admission, optional rollback effect and
// committed-event production share one serializable transaction.

import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import { nodeRuns, taskExecutionIntents } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { committedEventGroupId } from '@/platform/events/committed/types'
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
  type HumanGateNodeProjectionMember,
} from '../domain/humanGateContinuation'
import { linkPostgresqlWorkspaceRollbackEffectTx } from './postgresqlTaskExecutionEffectPersistence'
import { submitPostgresqlTaskContinuationTx } from './postgresqlTaskExecutionIntentPersistence'
import {
  transitionPostgresqlHumanGateTaskTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

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

export class PostgresqlTaskDecisionPersistence implements HumanGateDecisionPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async accept(input: AcceptHumanGateDecisionInput): Promise<AcceptedHumanGateDecision> {
    assertInput(input)
    return await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      const continuationLineage = canonicalHumanGateContinuationLineage(input.continuationLineage)
      const ids = [...continuationLineage.sourceNodeRunIds, ...continuationLineage.rerunNodeRunIds]
      const rows =
        ids.length === 0
          ? []
          : await tx.select().from(nodeRuns).where(inArray(nodeRuns.id, ids)).limit(ids.length)
      if (
        rows.length !== ids.length ||
        rows.some((row) => row.taskId !== input.taskId) ||
        input.expectedNodeProjection.memberCount !== ids.length
      ) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `human-gate node projection changed for task '${input.taskId}'`,
        )
      }
      const actual = humanGateNodeProjectionFence(rows.map(projectionMember))
      if (
        actual.memberCount !== input.expectedNodeProjection.memberCount ||
        actual.digest !== input.expectedNodeProjection.digest
      ) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `human-gate node projection digest changed for task '${input.taskId}'`,
          {
            expectedDigest: input.expectedNodeProjection.digest,
            currentDigest: actual.digest,
          },
        )
      }

      const transition = await transitionPostgresqlHumanGateTaskTx(tx, {
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
      const submitted = await submitPostgresqlTaskContinuationTx(tx, {
        taskId: input.taskId,
        intentId: ulid(),
        kind: 'gate-continuation',
        source: 'internal',
        actorUserId: null,
        payload,
        now: input.now,
        advanceOperationGeneration: false,
        admissionMode: 'successor-after-claimed',
      })

      if (input.workspaceRollbackPlan !== undefined) {
        const intentRows = await tx
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
          .limit(1)
        const intent = intentRows[0]
        if (intent === undefined) {
          throw new TaskExecutionError(
            'task-continuation-stale',
            `gate continuation '${submitted.intentId}' disappeared before effect linking`,
          )
        }
        const slotPath = decodeLineageSlotPath(intent.slotPathJson)
        const stableActionOrdinal = `human-gate:${input.operationId}`
        await linkPostgresqlWorkspaceRollbackEffectTx(tx, {
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
    })
  }
}
