// RFC-333 T7 — persist the manual question and its durable park obligation together.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { taskQuestions, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { HumanGateOperationStore } from '../application/ports/humanGateOperationStore'
import type {
  CreateManualQuestionOpenInput,
  CreatedManualQuestionOpen,
  ManualQuestionOpenWriter,
} from '../application/ports/manualQuestionOpenWriter'
import {
  canonicalHumanGateValueJson,
  type CanonicalHumanGateRequest,
} from '../domain/canonicalGateRequest'
import {
  encodeManualQuestionOpenManifest,
  manualQuestionProjectionDigest,
  type ManualQuestionOpenManifest,
  type ManualQuestionProjection,
} from '../domain/manualQuestionOpen'
import { appendHumanGateOpenedCommittedEventTx } from './collaborationCommittedEventParticipant'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'

export class SqliteManualQuestionOpenWriter implements ManualQuestionOpenWriter {
  constructor(
    private readonly db: DbClient,
    private readonly operations: HumanGateOperationStore,
  ) {}

  create(input: CreateManualQuestionOpenInput): CreatedManualQuestionOpen {
    const at = input.now ?? Date.now()
    const operationId = ulid(at)
    const questionId = ulid(at)
    const originNodeRunId = ulid(at)
    const created = dbTxSync(this.db, (tx) => {
      const task = tx
        .select({
          status: tasks.status,
          lifecycleEventRevision: tasks.lifecycleEventRevision,
        })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .get()
      if (task === undefined) {
        throw new ConflictError('task-not-found', `task ${input.taskId} not found`)
      }
      if (task.status === 'done' || task.status === 'canceled') {
        throw new ConflictError(
          'task-terminal',
          `task ${input.taskId} became ${task.status} before the manual question was inserted; nothing inserted`,
        )
      }
      const question: ManualQuestionProjection = {
        id: questionId,
        taskId: input.taskId,
        originNodeRunId,
        questionId: ulid(at),
        questionTitle: input.title,
        sourceKind: 'manual',
        roleKind: 'designer',
        iteration: 0,
        loopIter: 0,
        defaultTargetNodeId: null,
        overrideTargetNodeId: input.targetNodeId,
        dispatchedAt: null,
        dispatchedBy: null,
        triggerRunId: null,
        stagedAt: at,
        stagedBy: input.actorUserId,
        autoDispatchDeferredAt: null,
        sealedAt: null,
        sealedBy: null,
        confirmation: 'open',
        confirmedBy: null,
        confirmedByRole: null,
        confirmedAt: null,
        lastReassignedBy: null,
        lastReassignedAt: null,
        manualBody: input.body,
        manualCreatedBy: input.actorUserId,
        createdAt: at,
        updatedAt: at,
      }
      const sourceSnapshotDigest = sha256Hex(
        canonicalHumanGateValueJson({
          taskId: input.taskId,
          title: input.title,
          body: input.body,
          targetNodeId: input.targetNodeId,
          actorUserId: input.actorUserId,
        }),
      )
      const gateRef = `questions:${input.taskId}:manual:${question.id}`
      const manifest: ManualQuestionOpenManifest = {
        schemaVersion: 1,
        kind: 'manual-question-open',
        gateRef,
        sourceSnapshotDigest,
        nodeProjectionDigest: manualQuestionProjectionDigest({
          sourceSnapshotDigest,
          question,
        }),
        committedEventRef: `manual-question-open:${operationId}`,
        question,
      }
      const manifestJson = encodeManualQuestionOpenManifest(manifest)
      const request: CanonicalHumanGateRequest = {
        schemaVersion: 1,
        taskId: input.taskId,
        gateKind: 'questions',
        operationKind: 'manual-question-open',
        gateRef,
        actorUserId: input.actorUserId,
        expectedTaskRevision: task.lifecycleEventRevision,
        expectedGateRevision: 0,
        payload: {
          kind: 'manual-question-open',
          questionId: question.id,
          targetNodeId: input.targetNodeId,
        },
      }
      const begun = this.operations.beginTx({
        tx,
        operationId,
        request,
        idempotencyKey: `manual-question-open:${question.id}`,
        now: at,
      })
      if (begun.replayed) throw new Error('fresh manual-question identity unexpectedly replayed')
      tx.insert(taskQuestions).values(question).run()
      const operation = this.operations.markPreparedTx({
        tx,
        operationId,
        expectedClaimEpoch: begun.operation.claimEpoch,
        manifestJson,
        now: at,
      })
      const eventRef = appendHumanGateOpenedCommittedEventTx(tx, {
        family: 'questions',
        gate: {
          taskId: input.taskId,
          nodeRunId: question.originNodeRunId,
          gateKind: 'questions',
          gateId: gateRef,
          roundId: null,
        },
        occurredAt: at,
        identity: { operationRef: operationId },
      })
      return {
        id: question.id,
        operation,
        manifest,
        eventRefs: eventRef === null ? [] : [eventRef],
      }
    })
    publishCommittedEventsAfterCommit(created.eventRefs)
    return created
  }
}
