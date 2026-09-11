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
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskContinuationInput,
  SubmitTaskExecutionIntentInput,
} from '../application/ports/taskExecutionIntentPersistence'
import { TaskExecutionError } from '../application/taskExecutionError'
import { sha256Hex } from '../domain/digest'
import {
  canonicalJson,
  canonicalTaskLineageScope,
  continuationRequestHash,
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  lineagePathHasPrefix,
  mayAuthorizeReplay,
  type CanonicalContinuationRequest,
} from '../domain/executionIntent'

const MAX_INTENT_PAYLOAD_BYTES = 64 * 1024

/**
 * 那条 insert 撞唯一索引 ⇒ **领域错误**。
 *
 * 为什么判据是「是不是唯一冲突」而不是「撞的是哪条约束」（2026-09-10 修）：
 * 两个引擎的 `uniqueViolationTarget` 都用三态回答——`undefined` = 不是唯一冲突；
 * `''` = **是**唯一冲突但驱动没说是哪条（PG 的 23505 有时不带 `constraint`，SQLite 的
 * message 也可能匹配不出列清单）；非空串 = 约束名 / 列清单。初版按约束名正则判，于是
 * `''` 这一档被判成「不是冲突」，驱动错误原样漏给调用方——用户拿到 500 而不是 409。
 * 本机 200 轮并发复现不出来，CI 的 ubuntu 分片偶发地红过一次，说明它是真实可达的窄路径。
 *
 * 判据改成「这条 insert 上的任何唯一冲突」之所以安全，靠的是**作用域**：它只包住
 * `insert(taskExecutionIntents)` 这一条语句。该表能被违反的唯一约束只有它自己那两条部分唯一
 * 索引，而插入的是 `state: 'pending'` 的行，撞得到的只有 pending 那条。同事务还写
 * `taskExecutionLineageOperationRecords`（它也带唯一索引），但那是 UPDATE、不在这个 try 里
 * ——早先把映射放在整笔事务外面时，正是这一点逼着判据必须认约束名。
 */
export function pendingIntentInsertConflict(
  uniqueViolationTarget: (error: unknown) => string | undefined,
  taskId: string,
  error: unknown,
): never {
  if (uniqueViolationTarget(error) !== undefined) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      `task '${taskId}' already has an active continuation`,
    )
  }
  throw error
}

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
  // lineage 两列为 NULL 时的根作用域由 `canonicalTaskLineageScope` 派生——与
  // `submitTaskContinuation` 派生请求时**同一个函数**，否则两侧对 NULL 的解释会分叉。
  const canonical = canonicalTaskLineageScope(request.taskId, task)
  if (
    request.scope.executionLineageId !== canonical.executionLineageId ||
    encodeLineageSlotPath(request.scope.slotPath) !== encodeLineageSlotPath(canonical.slotPath)
  ) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${request.taskId}' lineage changed before continuation admission`,
    )
  }
  try {
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
  } catch (error) {
    pendingIntentInsertConflict(engineOf(tx).uniqueViolationTarget, request.taskId, error)
  }
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
  const { executionLineageId, slotPath } = canonicalTaskLineageScope(input.taskId, task)
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
