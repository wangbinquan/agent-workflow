// RFC-349 — PostgreSQL manual-question open atom. The question projection,
// prepared park obligation and collaboration outbox row commit together.

import { and, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { collaborationGateOperations, taskQuestions, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type {
  CreateManualQuestionOpenInput,
  CreatedManualQuestionOpen,
  ManualQuestionOpenWriter,
} from '../application/ports/manualQuestionOpenWriter'
import {
  canonicalHumanGateJson,
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  type CanonicalHumanGateRequest,
} from '../domain/canonicalGateRequest'
import type { HumanGateOperationSnapshot } from '../domain/humanGateOperation'
import {
  encodeManualQuestionOpenManifest,
  manualQuestionProjectionDigest,
  type ManualQuestionOpenManifest,
  type ManualQuestionProjection,
} from '../domain/manualQuestionOpen'
import { DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS } from './humanGateOperationTransactionStore'
import { appendPostgresqlHumanGateOpenedEventTx } from './postgresqlCollaborationCommittedEvents'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function retryable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (code === '40001' || code === '40P01') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

async function serializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (attempt < 2 && retryable(error)) continue
      throw error
    }
  }
}

function operationSnapshot(
  row: typeof collaborationGateOperations.$inferSelect,
): HumanGateOperationSnapshot {
  return {
    id: row.id,
    taskId: row.taskId,
    gateKind: row.gateKind,
    operationKind: row.operationKind,
    gateRef: row.gateRef,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    actorUserId: row.actorUserId,
    expectedTaskRevision: row.expectedTaskRevision,
    expectedGateRevision: row.expectedGateRevision,
    resultGateRevision: row.resultGateRevision,
    state: row.state,
    claimEpoch: row.claimEpoch,
    claimExpiresAt: row.claimExpiresAt,
    schemaVersion: row.schemaVersion,
    manifestJson: row.manifestJson,
    receiptJson: row.receiptJson,
    failureJson: row.failureJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    committedAt: row.committedAt,
    completedAt: row.completedAt,
  }
}

export class PostgresqlManualQuestionOpenWriter implements ManualQuestionOpenWriter {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async create(input: CreateManualQuestionOpenInput): Promise<CreatedManualQuestionOpen> {
    const at = input.now ?? Date.now()
    const operationId = ulid(at)
    const questionId = ulid(at)
    const originNodeRunId = ulid(at)
    const created = await serializable(this.db, async (tx) => {
      const taskRows = await tx
        .select({ status: tasks.status, lifecycleEventRevision: tasks.lifecycleEventRevision })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
      const task = taskRows[0]
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
        nodeProjectionDigest: manualQuestionProjectionDigest({ sourceSnapshotDigest, question }),
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

      const activeRows = await tx
        .select({ id: collaborationGateOperations.id })
        .from(collaborationGateOperations)
        .where(
          and(
            eq(collaborationGateOperations.taskId, request.taskId),
            eq(collaborationGateOperations.gateKind, request.gateKind),
            eq(collaborationGateOperations.gateRef, request.gateRef),
            eq(collaborationGateOperations.operationKind, request.operationKind),
            inArray(collaborationGateOperations.state, [
              'preparing',
              'prepared',
              'committed',
              'cleanup_pending',
            ]),
          ),
        )
        .limit(1)
      if (activeRows[0] !== undefined) {
        throw new ConflictError(
          'human-gate-operation-conflict',
          `human-gate '${request.gateRef}' already has an active operation`,
        )
      }

      await tx
        .insert(collaborationGateOperations)
        .values({
          id: operationId,
          taskId: request.taskId,
          gateKind: request.gateKind,
          operationKind: request.operationKind,
          gateRef: request.gateRef,
          idempotencyKey: `manual-question-open:${question.id}`,
          requestHash: canonicalHumanGateRequestHash(request),
          actorUserId: request.actorUserId,
          expectedTaskRevision: request.expectedTaskRevision,
          expectedGateRevision: request.expectedGateRevision,
          resultGateRevision: null,
          state: 'preparing',
          claimEpoch: 1,
          claimExpiresAt: at + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
          schemaVersion: 1,
          manifestJson: canonicalHumanGateJson(request),
          receiptJson: null,
          failureJson: null,
          createdAt: at,
          updatedAt: at,
          committedAt: null,
          completedAt: null,
        })
        .run()
      await tx.insert(taskQuestions).values(question).run()
      const preparedRows = await tx
        .update(collaborationGateOperations)
        .set({
          state: 'prepared',
          manifestJson,
          claimExpiresAt: at + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
          updatedAt: at,
        })
        .where(
          and(
            eq(collaborationGateOperations.id, operationId),
            eq(collaborationGateOperations.state, 'preparing'),
            eq(collaborationGateOperations.claimEpoch, 1),
          ),
        )
        .returning()
      const prepared = preparedRows[0]
      if (prepared === undefined) {
        throw new ConflictError(
          'human-gate-operation-stale',
          `manual-question operation '${operationId}' changed during preparation`,
        )
      }
      const eventRef = await appendPostgresqlHumanGateOpenedEventTx(tx, {
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
        operation: operationSnapshot(prepared),
        manifest,
        eventRefs: eventRef === null ? [] : [eventRef],
      }
    })
    await publishCommittedEventsAfterCommit(created.eventRefs)
    return created
  }
}
