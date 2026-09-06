// RFC-359 W4-D26 —— 手工提问的开启写面：一份实现，两个引擎共用。
//
// 合一前 `sqliteManualQuestionOpenWriter.ts` 走 `SqliteHumanGateOperationStore` 的
// `beginTx` / `markPreparedTx` 记账，`postgresqlManualQuestionOpenWriter.ts` 把这两步**内联重写**
// 成裸 INSERT + UPDATE：不查幂等键回放、claimEpoch 恒写 1、也不比 requestHash。正典取 SQLite 的
// 记账语义，而它早有中立副本 `DatabaseHumanGateOperationJournal`——直接用，PG 侧顺带补齐这三条。
//
// 事务用中立 `serializable`：SQLite 是 BEGIN IMMEDIATE（本来就全库独占），PG 抬到 SERIALIZABLE 并按
// 40001 重放，与合一前两侧各自的隔离级别逐字相同。

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskQuestions, tasks } from '@/db/schema'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
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
import { appendHumanGateOpenedCommittedEvent } from './collaborationCommittedEvents'
import type { HumanGateOperationJournal } from './humanGateOperationJournal'

export class DatabaseManualQuestionOpenWriter implements ManualQuestionOpenWriter {
  constructor(
    private readonly db: ProviderNeutralDatabase,
    private readonly journal: HumanGateOperationJournal,
  ) {}

  async create(input: CreateManualQuestionOpenInput): Promise<CreatedManualQuestionOpen> {
    const at = input.now ?? Date.now()
    const operationId = ulid(at)
    const questionId = ulid(at)
    const originNodeRunId = ulid(at)
    const created = await databaseSessionFor(this.db).serializable(async (tx) => {
      const task = (
        await tx
          .select({ status: tasks.status, lifecycleEventRevision: tasks.lifecycleEventRevision })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .limit(1)
      )[0]
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
      const begun = await this.journal.beginTx({
        tx,
        operationId,
        request,
        idempotencyKey: `manual-question-open:${question.id}`,
        now: at,
      })
      if (begun.replayed) throw new Error('fresh manual-question identity unexpectedly replayed')
      await tx.insert(taskQuestions).values(question).run()
      const operation = await this.journal.markPreparedTx({
        tx,
        operationId,
        expectedClaimEpoch: begun.operation.claimEpoch,
        manifestJson,
        now: at,
      })
      const eventRef = await appendHumanGateOpenedCommittedEvent(tx, {
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
    await publishCommittedEventsAfterCommit(created.eventRefs)
    return created
  }
}
