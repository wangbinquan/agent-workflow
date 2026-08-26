// RFC-328 — the one continuation-admission transaction used by every kick.

import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { taskExecutionIntents, taskExecutionLineageOperationRecords, tasks } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { taskExecutionModule } from '../composition'
import {
  canonicalJson,
  decodeLineageSlotPath,
  lineagePathHasPrefix,
  mayAuthorizeReplay,
  type CanonicalContinuationRequest,
  type TaskExecutionIntentKind,
  type TaskExecutionIntentSource,
} from '../domain/executionIntent'
import { TaskExecutionError } from './taskExecutionError'

export interface SubmitTaskContinuationInput {
  readonly taskId: string
  readonly intentId: string
  readonly kind: TaskExecutionIntentKind
  readonly source: TaskExecutionIntentSource
  readonly actorUserId: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly now: number
  readonly advanceOperationGeneration: boolean
}

export function submitTaskContinuationTx(tx: DbTxSync, input: SubmitTaskContinuationInput): void {
  const task = tx
    .select({
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      executionLineageId: tasks.executionLineageId,
      lineageSlotPathJson: tasks.lineageSlotPathJson,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .get()
  if (task === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.taskId}' disappeared before continuation admission`,
    )
  }

  const latest = tx
    .select({
      continuationSlotKey: taskExecutionIntents.continuationSlotKey,
      operationGeneration: taskExecutionIntents.operationGeneration,
    })
    .from(taskExecutionIntents)
    .where(eq(taskExecutionIntents.taskId, input.taskId))
    .orderBy(desc(taskExecutionIntents.createdAt), desc(taskExecutionIntents.id))
    .limit(1)
    .get()
  const executionLineageId = task.executionLineageId ?? input.taskId
  const slotPath =
    task.lineageSlotPathJson === null
      ? [
          {
            stableNodeKey: 'task-root',
            frozenOccurrenceKey: executionLineageId,
            workflowRevision: null,
          },
        ]
      : decodeLineageSlotPath(task.lineageSlotPathJson)
  const continuationSlotKey =
    latest?.continuationSlotKey ??
    createHash('sha256')
      .update(`${executionLineageId}\u0000${task.lineageSlotPathJson ?? input.taskId}`)
      .digest('hex')
  const operationGeneration =
    (latest?.operationGeneration ?? 0) + (input.advanceOperationGeneration ? 1 : 0)
  const replayAuthorized = mayAuthorizeReplay({
    kind: input.kind,
    source: input.source,
    actorUserId: input.actorUserId,
  })
  const replayAuthorizationId = replayAuthorized ? ulid() : null
  const authorizationScopeJson = replayAuthorized
    ? canonicalJson({
        v: 1,
        executionLineageId,
        continuationSlotKey,
        slotPath,
        operationGeneration,
      })
    : null

  const selectedUnknownDecisions = tx
    .select()
    .from(taskExecutionLineageOperationRecords)
    .where(
      and(
        eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
        eq(taskExecutionLineageOperationRecords.executionLineageId, executionLineageId),
        eq(taskExecutionLineageOperationRecords.decisionState, 'requires-actor'),
      ),
    )
    .all()
    .filter((decision) => {
      try {
        return lineagePathHasPrefix(decodeLineageSlotPath(decision.slotPathJson), slotPath)
      } catch {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `retained replay decision '${decision.id}' has an invalid lineage path`,
        )
      }
    })
  if (selectedUnknownDecisions.length > 0 && replayAuthorizationId === null) {
    throw new TaskExecutionError(
      'task-execution-outcome-unknown',
      'this continuation includes an operation with unknown outcome; use a manual resume/retry/sync command',
      { unresolvedDecisionRefs: selectedUnknownDecisions.map((decision) => decision.id) },
    )
  }
  const request: CanonicalContinuationRequest = {
    taskId: input.taskId,
    kind: input.kind,
    source: input.source,
    actorUserId: input.actorUserId,
    expectedTaskRevision: task.lifecycleEventRevision,
    scope: {
      executionLineageId,
      continuationSlotKey,
      slotPath,
      operationGeneration,
    },
    payload: input.payload,
  }
  taskExecutionModule.intents.submitTx({
    tx,
    request,
    intentId: input.intentId,
    replayAuthorizationId,
    authorizationScopeJson,
    now: input.now,
  })
  for (const decision of selectedUnknownDecisions) {
    const rebound = tx
      .update(taskExecutionLineageOperationRecords)
      .set({
        decisionState: 'actor-replay-authorized',
        replayAuthorizationId,
        authorizationScopeJson,
        actorUserId: input.actorUserId,
        authorizationSource: input.source,
        boundIntentId: input.intentId,
        recordRevision: decision.recordRevision + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.id, decision.id),
          eq(taskExecutionLineageOperationRecords.recordRevision, decision.recordRevision),
          eq(taskExecutionLineageOperationRecords.decisionState, 'requires-actor'),
        ),
      )
      .returning({ id: taskExecutionLineageOperationRecords.id })
      .get()
    if (rebound === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `replay decision '${decision.id}' changed during continuation admission`,
      )
    }
  }
}

export function submitTaskContinuation(db: DbClient, input: SubmitTaskContinuationInput): void {
  dbTxSync(db, (tx) => submitTaskContinuationTx(tx, input))
}
