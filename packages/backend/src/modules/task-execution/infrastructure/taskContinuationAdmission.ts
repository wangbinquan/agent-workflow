// RFC-359 —— 任务 continuation 的准入（intent 提交）：一份实现，两个引擎。
//
// 以前 `sqliteTaskExecutionIntent.ts` + `sqliteTaskExecutionIntentAdmission.ts`（同步）与
// `postgresqlTaskExecutionIntentPersistence.ts`（异步）各抄一份逐字相同的逻辑。这里是那份逻辑的
// 唯一 async 版本；同步版本在其余 dbTxSync 调用方迁完之前保留。调用方在
// `DatabaseSession.transaction` 体内传 `tx`；同任务的并发准入由 CAS（active intent 检查 +
// lineage 复核）与调用方的聚合根行锁共同保证。

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceMembers,
  tasks,
} from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskContinuationInput,
  SubmitTaskExecutionIntentInput,
} from '../application/ports/taskExecutionIntentPersistence'
import { TaskExecutionError } from '../application/taskExecutionError'
import { sha256Hex } from '../domain/digest'
import {
  canonicalJson,
  continuationRequestHash,
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  lineagePathHasPrefix,
  mayAuthorizeReplay,
  type CanonicalContinuationRequest,
} from '../domain/executionIntent'

const MAX_INTENT_PAYLOAD_BYTES = 64 * 1024

function encodedIntentPayload(payload: unknown): string {
  const encoded = canonicalJson(payload)
  if (Buffer.byteLength(encoded) > MAX_INTENT_PAYLOAD_BYTES) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'task continuation payload exceeds the internal 64 KiB limit',
    )
  }
  return encoded
}

/** 已规范化请求的准入：修订号 / 维护占用 / 活跃 intent / lineage 四道判据后落一行 pending intent。 */
export async function submitCanonicalTaskExecutionIntent(
  tx: DatabaseTransaction,
  input: SubmitTaskExecutionIntentInput,
  intentId: string,
  now: number,
): Promise<SubmittedTaskExecutionIntent> {
  const { request } = input
  const task = await tx
    .select({
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      executionLineageId: tasks.executionLineageId,
      lineageSlotPathJson: tasks.lineageSlotPathJson,
    })
    .from(tasks)
    .where(eq(tasks.id, request.taskId))
    .get()
  if (task === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${request.taskId}' does not exist`,
    )
  }
  if (task.lifecycleEventRevision !== request.expectedTaskRevision) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${request.taskId}' changed before continuation admission`,
      {
        expectedRevision: request.expectedTaskRevision,
        currentRevision: task.lifecycleEventRevision,
      },
    )
  }
  const maintenance = await tx
    .select({ claimId: taskExecutionMaintenanceMembers.claimId })
    .from(taskExecutionMaintenanceMembers)
    .where(
      and(
        eq(taskExecutionMaintenanceMembers.taskId, request.taskId),
        isNull(taskExecutionMaintenanceMembers.releasedAt),
      ),
    )
    .get()
  if (maintenance !== undefined) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${request.taskId}' is claimed by terminal maintenance`,
      { claimRef: maintenance.claimId },
    )
  }

  const hash = continuationRequestHash(request)
  const active = await tx
    .select({
      id: taskExecutionIntents.id,
      requestHash: taskExecutionIntents.requestHash,
      state: taskExecutionIntents.state,
    })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.taskId, request.taskId),
        inArray(taskExecutionIntents.state, ['pending', 'claimed']),
      ),
    )
    .limit(2)
  const replay = active.find((intent) => intent.requestHash === hash)
  if (replay !== undefined) {
    return { intentId: replay.id, state: replay.state, idempotent: true, requestHash: hash }
  }
  const pending = active.find((intent) => intent.state === 'pending')
  const claimed = active.find((intent) => intent.state === 'claimed')
  if (
    pending !== undefined ||
    (claimed !== undefined && input.admissionMode !== 'successor-after-claimed')
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      `task '${request.taskId}' already has an active continuation`,
      { winnerIntentRef: (pending ?? claimed)?.id },
    )
  }

  // 迁移期的 json_object/json_array 保留插入顺序，而 encodeLineageSlotPath 会规范化键序；
  // 解码后再比较，迁移过来的任务与应用写入的任务才有相同的 continuation 语义。
  const storedSlotPathJson =
    task.lineageSlotPathJson === null
      ? null
      : encodeLineageSlotPath(decodeLineageSlotPath(task.lineageSlotPathJson))
  if (
    request.scope.executionLineageId !== task.executionLineageId ||
    encodeLineageSlotPath(request.scope.slotPath) !== storedSlotPathJson
  ) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${request.taskId}' lineage changed before continuation admission`,
    )
  }
  await tx
    .insert(taskExecutionIntents)
    .values({
      id: intentId,
      taskId: request.taskId,
      kind: request.kind,
      state: 'pending',
      source: request.source,
      requestHash: hash,
      payloadJson: encodedIntentPayload(request.payload),
      executionLineageId: request.scope.executionLineageId,
      continuationSlotKey: request.scope.continuationSlotKey,
      slotPathJson: encodeLineageSlotPath(request.scope.slotPath),
      operationGeneration: request.scope.operationGeneration,
      replayAuthorizationId: input.replayAuthorizationId ?? null,
      authorizationScopeJson: input.authorizationScopeJson ?? null,
      expectedTaskRevision: request.expectedTaskRevision,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { intentId, state: 'pending', idempotent: false, requestHash: hash }
}

/**
 * 从任务当前 lineage 派生 continuation 请求并准入；同事务把命中的「需要 actor 授权重放」
 * 决定绑定到新 intent 上。
 */
export async function submitTaskContinuation(
  tx: DatabaseTransaction,
  input: SubmitTaskContinuationInput,
): Promise<SubmittedTaskExecutionIntent> {
  const task = await tx
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
  const latest = await tx
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
    sha256Hex(`${executionLineageId}\u0000${task.lineageSlotPathJson ?? input.taskId}`)
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

  const retained = await tx
    .select()
    .from(taskExecutionLineageOperationRecords)
    .where(
      and(
        eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
        eq(taskExecutionLineageOperationRecords.executionLineageId, executionLineageId),
        eq(taskExecutionLineageOperationRecords.decisionState, 'requires-actor'),
      ),
    )
  const selected = retained.filter((decision) => {
    try {
      return lineagePathHasPrefix(decodeLineageSlotPath(decision.slotPathJson), slotPath)
    } catch {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `retained replay decision '${decision.id}' has an invalid lineage path`,
      )
    }
  })
  if (selected.length > 0 && replayAuthorizationId === null) {
    throw new TaskExecutionError(
      'task-execution-outcome-unknown',
      'this continuation includes an operation with unknown outcome; use a manual resume/retry/sync command',
      { unresolvedDecisionRefs: selected.map((decision) => decision.id) },
    )
  }
  const request: CanonicalContinuationRequest = {
    taskId: input.taskId,
    kind: input.kind,
    source: input.source,
    actorUserId: input.actorUserId,
    expectedTaskRevision: task.lifecycleEventRevision,
    scope: { executionLineageId, continuationSlotKey, slotPath, operationGeneration },
    payload: input.payload,
  }
  const submitted = await submitCanonicalTaskExecutionIntent(
    tx,
    {
      request,
      intentId: input.intentId,
      replayAuthorizationId,
      authorizationScopeJson,
      admissionMode: input.admissionMode ?? 'exclusive',
      now: input.now,
    },
    input.intentId,
    input.now,
  )
  for (const decision of selected) {
    const rebound = await tx
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
    if (rebound[0] === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `replay decision '${decision.id}' changed during continuation admission`,
      )
    }
  }
  return submitted
}
