// RFC-359 W8 —— effect 账本 / attempt 台账 / 资源围栏：**一份**实现，两个 provider 共用。
//
// 此前是一对同构引擎：
//   · SQLite：`sqliteTaskExecutionEffectPersistence.ts`（369 行 Promise 薄壳）转发到
//     `sqliteTaskExecutionEffect.ts` 的 `SqliteTaskExecutionEffectStore`（planCodeHostAttempt /
//     nextOperationGeneration / prepareAndAcquire / settle 四个同步方法，约 583 行，
//     `withOwnedTaskTx` + `dbTxSync`），投影用 `onSettledTx` 回调挂在同一笔事务里；
//   · PostgreSQL：`postgresqlTaskExecutionEffectPersistence.ts`（1007 行）自带 SERIALIZABLE 事务、
//     私有 `assertOwner` 与私有 `uniqueViolation` 分类。
// 同一张 `task_execution_effects` / `_attempts` / `_fences` / `lineage_operation_records` 账本、
// 同一套 domain 判定、同一批错误码——是重复，不是能力缺口。
//
// 合一时按**强侧**抬齐（对拍见 `tests/rfc359-w8-effect-persistence-conformance.test.ts`）：
//   · owner 围栏：走统一原语 `assertTaskOwnerTx`（owner 行上的条件 UPDATE + revision 前进）。
//     此前只有 SQLite 这么做，PG 是只读 SELECT 检查——没有行锁，同一任务的两个写手可以同时穿过。
//   · 每一步 CAS 都验受影响行（PG 侧原有），SQLite 侧此前一律 `.run()` 不看结果：
//     attempt 转 acting / effect 推进 lastAttemptNo / attempt 结算 / effect 终态 / watermark 前进 /
//     spawn 回执与 node_run 投影 / 回滚投影逐行，任何一条丢了都抛 `task-execution-stale-owner`。
//   · node_run 投影走两引擎共用的事务内 CAS（`nodeRunLifecycleTransition.setNodeRunStatusTx`）：
//     终态闸 + `allowedFrom` + MR/PR source-termination 围栏 + `node-run-not-found`。此前只有
//     SQLite 侧如此，PG 手写 `update … where status='running'`（判据缺口
//     `03-pg-code-host-projection-node-run-cas`，本文件合一即关闭）。
//   · 唯一冲突分类走能力矩阵 `classifyError`：PG 的私有分类只看 `error.code === '23505'`，而
//     Bun.SQL 把 SQLSTATE 放在 `errno`（对账 F-I-13），于是 PG 上资源围栏抢占抛的是裸
//     `DrizzleQueryError` 而不是 `task-execution-resource-conflict`。
//   · receipt 边界：字节上限（PG 侧）+ JSON 合法性（SQLite 侧）两条都做，抛 `TaskExecutionError`。
//
// 事务形状沿用两侧原有的最强档：`withTaskExecutionSerializable`（PG = SERIALIZABLE + 40001 重放；
// SQLite = BEGIN IMMEDIATE，本就全库独占）。事务体只 await 数据库操作。

import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunOutputs,
  nodeRuns,
  taskRepos,
  taskSpaceNodes,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  tasks,
} from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type {
  CodeHostNodeSettlementProjection,
  GateRollbackSettlement,
  TaskEffectAttemptSettlement,
  TaskExecutionEffectPersistence,
  WorkspacePreparationSettlementProjection,
} from '../application/ports/taskExecutionEffectStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  aggregateEffectOutcome,
  assertAttemptTransition,
  canCreateNextAttempt,
  canonicalResourceKeySet,
  type AttemptEvidence,
} from '../domain/executionEffect'
import {
  closeOutcomeUnknownAndRelease,
  readUnreapedProcessCode,
  readUnresolvedEffectIds,
  resolveQuiescedManagedProcesses,
} from './effectQuiescence'
import { setNodeRunStatusTx } from './nodeRunLifecycleTransition'
import {
  assertTaskOwnerTx,
  withTaskExecutionSerializable,
  type TaskExecutionTransaction,
} from './ownedTaskExecution'

const MAX_RECEIPT_BYTES = 64 * 1024

/** 回执 / 恢复描述符的入库闸：≤64 KiB 且必须是合法 JSON。 */
function bounded(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (Buffer.byteLength(value) > MAX_RECEIPT_BYTES) {
    throw new TaskExecutionError('task-continuation-conflict', 'effect receipt exceeds 64 KiB')
  }
  try {
    JSON.parse(value)
  } catch {
    throw new TaskExecutionError('task-continuation-conflict', 'effect receipt is not valid JSON')
  }
  return value
}

/** code-host 结算的 node_run 投影：输出 upsert + 共用的事务内状态 CAS。 */
async function applyCodeHostProjection(
  tx: TaskExecutionTransaction,
  projection: CodeHostNodeSettlementProjection,
): Promise<void> {
  for (const output of projection.outputs ?? []) {
    await tx
      .insert(nodeRunOutputs)
      .values({ nodeRunId: projection.nodeRunId, ...output })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: output.content },
      })
      .run()
  }
  await setNodeRunStatusTx({
    tx,
    nodeRunId: projection.nodeRunId,
    to: projection.status,
    allowedFrom: ['running'],
    reason: projection.reason,
    extra: {
      finishedAt: projection.finishedAt,
      ...(projection.errorMessage === undefined ? {} : { errorMessage: projection.errorMessage }),
      ...(projection.failureCode === undefined ? {} : { failureCode: projection.failureCode }),
    },
  })
}

/** 工作区准备结算的投影：任务列 + 仓库行 + 空间目录 + prep node_run 同笔落库。 */
async function applyWorkspacePreparationProjection(
  tx: TaskExecutionTransaction,
  projection: WorkspacePreparationSettlementProjection,
): Promise<void> {
  await tx.update(tasks).set(projection.task).where(eq(tasks.id, projection.taskId)).run()
  if (projection.repositories.length > 0) {
    await tx
      .insert(taskRepos)
      .values(projection.repositories.map((row) => ({ ...row })))
      .run()
  }
  if (projection.nodePaths.length > 0) {
    await tx
      .insert(taskSpaceNodes)
      .values(
        projection.nodePaths.map((nodePath) => ({
          taskId: projection.taskId,
          nodePath,
          schemaVersion: 1,
        })),
      )
      .run()
  }
  await setNodeRunStatusTx({
    tx,
    nodeRunId: projection.prepNodeRunId,
    to: 'done',
    allowedFrom: ['running'],
    reason: 'repo-prep-done',
    extra: { finishedAt: projection.finishedAt },
  })
}

/** 回滚确实跑完了的那一支（`threw` 没有投影可做）。 */
type CompletedGateRollback = Extract<GateRollbackSettlement['outcome'], { kind: 'completed' }>

/** 人工门回滚结算的投影：按成功集合改写来源 node_run 的 rolledBack / errorMessage。 */
async function applyGateRollbackProjection(
  tx: TaskExecutionTransaction,
  input: Readonly<{
    taskId: string
    operationId: string
    sourceNodeRunIds: readonly string[]
    outcome: CompletedGateRollback
  }>,
): Promise<void> {
  if (input.sourceNodeRunIds.length === 0) return
  const rows = await tx
    .select({ id: nodeRuns.id, errorMessage: nodeRuns.errorMessage })
    .from(nodeRuns)
    .where(
      and(eq(nodeRuns.taskId, input.taskId), inArray(nodeRuns.id, [...input.sourceNodeRunIds])),
    )
    .limit(input.sourceNodeRunIds.length)
  if (rows.length !== input.sourceNodeRunIds.length) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `workspace rollback projection for '${input.operationId}' lost a source row`,
    )
  }
  const successful = new Set(input.outcome.successfulSourceNodeRunIds)
  for (const row of rows) {
    const rolledBack = successful.has(row.id)
    const updated = await tx
      .update(nodeRuns)
      .set({
        rolledBack,
        errorMessage:
          row.errorMessage === null
            ? null
            : row.errorMessage.replace(
                /^(superseded-by-review-(?:rejected|iterated))(?:-rollback)?:/,
                `$1${rolledBack ? '-rollback' : ''}:`,
              ),
      })
      .where(and(eq(nodeRuns.id, row.id), eq(nodeRuns.taskId, input.taskId)))
      .returning({ id: nodeRuns.id })
    if (updated[0] === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `workspace rollback projection for '${input.operationId}' lost source '${row.id}'`,
      )
    }
  }
}

export class DrizzleTaskExecutionEffectPersistence implements TaskExecutionEffectPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async readLineage(input: Parameters<TaskExecutionEffectPersistence['readLineage']>[0]) {
    const taskRows = await this.db
      .select({
        executionLineageId: tasks.executionLineageId,
        lineageSlotPathJson: tasks.lineageSlotPathJson,
        workflowVersion: tasks.workflowVersion,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
    const intentRows = await this.db
      .select({
        executionLineageId: taskExecutionIntents.executionLineageId,
        continuationSlotKey: taskExecutionIntents.continuationSlotKey,
        slotPathJson: taskExecutionIntents.slotPathJson,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.id, input.intentId),
          eq(taskExecutionIntents.taskId, input.taskId),
        ),
      )
      .limit(1)
    const runRows =
      input.nodeRunId === undefined
        ? []
        : await this.db
            .select({
              nodeId: nodeRuns.nodeId,
              iteration: nodeRuns.iteration,
              retryIndex: nodeRuns.retryIndex,
              shardKey: nodeRuns.shardKey,
              continuationSlotKey: nodeRuns.continuationSlotKey,
              lineageSlotPathJson: nodeRuns.lineageSlotPathJson,
            })
            .from(nodeRuns)
            .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.taskId, input.taskId)))
            .limit(1)
    const task = taskRows[0]
    const intent = intentRows[0]
    const run = runRows[0]
    if (
      task === undefined ||
      intent === undefined ||
      (input.nodeRunId !== undefined && run === undefined)
    ) {
      return null
    }
    return {
      executionLineageId: task.executionLineageId ?? intent.executionLineageId,
      continuationSlotKey: run?.continuationSlotKey ?? intent.continuationSlotKey,
      slotPathJson:
        run?.lineageSlotPathJson ?? intent.slotPathJson ?? task.lineageSlotPathJson ?? '[]',
      workflowVersion: task.workflowVersion,
      nodeId: run?.nodeId ?? null,
      iteration: run?.iteration ?? null,
      retryIndex: run?.retryIndex ?? null,
      shardKey: run?.shardKey ?? null,
    }
  }

  async nextOperationGeneration(
    input: Parameters<TaskExecutionEffectPersistence['nextOperationGeneration']>[0],
  ): Promise<number> {
    const live = await this.db
      .select({ generation: max(taskExecutionEffects.operationGeneration) })
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
    const retained = await this.db
      .select({ generation: taskExecutionLineageOperationRecords.highestSettledGeneration })
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .limit(1)
    return Math.max(live[0]?.generation ?? -1, retained[0]?.generation ?? -1) + 1
  }

  async planCodeHostAttempt(
    input: Parameters<TaskExecutionEffectPersistence['planCodeHostAttempt']>[0],
  ) {
    const effects = await this.db
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .orderBy(desc(taskExecutionEffects.operationGeneration))
      .limit(1)
    const highest = effects[0]
    if (highest?.state === 'open') {
      const attempts = await this.db
        .select({
          state: taskExecutionEffectAttempts.state,
          retryAuthority: taskExecutionEffectAttempts.retryAuthority,
        })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.effectId, highest.id))
        .orderBy(desc(taskExecutionEffectAttempts.attemptNo))
        .limit(1)
      const latest = attempts[0]
      if (latest?.state === 'retry-authorized' && latest.retryAuthority !== 'none') {
        return {
          operationGeneration: highest.operationGeneration,
          retryAuthority: latest.retryAuthority,
        }
      }
    }
    return {
      operationGeneration: await this.nextOperationGeneration(input),
      retryAuthority: 'none' as const,
    }
  }

  async prepareAndAcquire(
    input: Parameters<TaskExecutionEffectPersistence['prepareAndAcquire']>[0],
  ) {
    const now = input.now ?? Date.now()
    const resources = canonicalResourceKeySet(input.resourceKeys)
    const recoveryDescriptorJson = bounded(input.recoveryDescriptorJson)
    return await withTaskExecutionSerializable(this.db, async (tx) => {
      await assertTaskOwnerTx(tx, input.token, now)
      const intents = await tx
        .select({
          id: taskExecutionIntents.id,
          taskId: taskExecutionIntents.taskId,
          state: taskExecutionIntents.state,
          claimedEpoch: taskExecutionIntents.claimedEpoch,
          replayAuthorizationId: taskExecutionIntents.replayAuthorizationId,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, input.intentId))
        .limit(1)
      const intent = intents[0]
      if (
        intent === undefined ||
        intent.taskId !== input.token.taskId ||
        intent.state !== 'claimed' ||
        intent.claimedEpoch !== input.token.epoch
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `intent '${input.intentId}' is not claimed by the current owner epoch`,
        )
      }
      const found = await tx
        .select()
        .from(taskExecutionEffects)
        .where(
          and(
            eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
            eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
            eq(taskExecutionEffects.operationGeneration, input.operationGeneration),
          ),
        )
        .limit(1)
      let effect = found[0]
      if (effect !== undefined) {
        if (
          effect.taskId !== input.token.taskId ||
          effect.operationKey !== input.operationKey ||
          effect.kind !== input.kind ||
          effect.requestHash !== input.requestHash ||
          effect.slotPathDigest !== input.slotPathDigest
        ) {
          throw new TaskExecutionError(
            'task-continuation-conflict',
            'logical effect identity was reused with different immutable input',
          )
        }
        if (effect.state !== 'open') {
          throw new TaskExecutionError(
            effect.state === 'outcome-unknown'
              ? 'task-execution-outcome-unknown'
              : 'task-continuation-conflict',
            `logical effect '${effect.id}' is already ${effect.state}`,
          )
        }
      } else {
        const watermarkRows = await tx
          .select()
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
              eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
              eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
            ),
          )
          .limit(1)
        const liveRows = await tx
          .select({ generation: max(taskExecutionEffects.operationGeneration) })
          .from(taskExecutionEffects)
          .where(
            and(
              eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
              eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
            ),
          )
        const watermark = watermarkRows[0]
        const highest = Math.max(
          watermark?.highestSettledGeneration ?? -1,
          liveRows[0]?.generation ?? -1,
        )
        if (input.operationGeneration !== highest + 1) {
          throw new TaskExecutionError(
            'task-continuation-stale',
            `operation generation ${input.operationGeneration} is not next after ${highest}`,
          )
        }
        const predecessorRows = await tx
          .select()
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
              eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
              eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
              eq(
                taskExecutionLineageOperationRecords.operationGeneration,
                input.operationGeneration - 1,
              ),
            ),
          )
          .limit(1)
        const predecessor = predecessorRows[0]
        if (
          predecessor !== undefined &&
          (predecessor.decisionState !== 'actor-replay-authorized' ||
            predecessor.replayAuthorizationId !== intent.replayAuthorizationId ||
            predecessor.boundIntentId !== intent.id)
        ) {
          throw new TaskExecutionError(
            'task-execution-outcome-unknown',
            'the prior unknown operation has no matching actor replay authorization',
          )
        }
        const effectId = ulid()
        await tx
          .insert(taskExecutionEffects)
          .values({
            id: effectId,
            taskId: input.token.taskId,
            originIntentId: input.intentId,
            currentIntentId: input.intentId,
            operationKey: input.operationKey,
            executionLineageId: input.executionLineageId,
            operationFamilyKey: input.operationFamilyKey,
            operationGeneration: input.operationGeneration,
            kind: input.kind,
            requestHash: input.requestHash,
            slotPathJson: input.slotPathJson,
            slotPathDigest: input.slotPathDigest,
            state: 'open',
            lastAttemptNo: 0,
            preparedAt: now,
            updatedAt: now,
          })
          .run()
        const inserted = await tx
          .select()
          .from(taskExecutionEffects)
          .where(eq(taskExecutionEffects.id, effectId))
          .limit(1)
        effect = inserted[0]
        if (effect === undefined) throw new Error('effect insert did not materialize')
        if (predecessor !== undefined) {
          const consumed = await tx
            .update(taskExecutionLineageOperationRecords)
            .set({
              decisionState: 'consumed',
              boundIntentId: null,
              newEffectId: effectId,
              recordRevision: predecessor.recordRevision + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(taskExecutionLineageOperationRecords.id, predecessor.id),
                eq(taskExecutionLineageOperationRecords.recordRevision, predecessor.recordRevision),
                eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
              ),
            )
            .returning({ id: taskExecutionLineageOperationRecords.id })
          if (consumed[0] === undefined) {
            throw new TaskExecutionError('task-continuation-stale', 'replay authorization changed')
          }
        }
      }

      const prior = await tx
        .select({
          attemptNo: taskExecutionEffectAttempts.attemptNo,
          state: taskExecutionEffectAttempts.state,
          applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
          retryAuthority: taskExecutionEffectAttempts.retryAuthority,
        })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
        .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
      const attemptNo = prior.length + 1
      if (prior.some((attempt, index) => attempt.attemptNo !== index + 1)) {
        throw new Error('non-monotonic persisted effect attempts')
      }
      const previous = prior.at(-1)
      if (
        previous !== undefined &&
        !canCreateNextAttempt({
          previous: {
            attemptNo: previous.attemptNo,
            state: previous.state,
            applicationEvidence: previous.applicationEvidence ?? 'ambiguous',
          },
          retryAuthority: input.retryAuthority,
        })
      ) {
        throw new TaskExecutionError(
          'task-continuation-conflict',
          `effect '${effect.id}' does not permit attempt ${attemptNo}`,
        )
      }
      const attemptId = ulid()
      await tx
        .insert(taskExecutionEffectAttempts)
        .values({
          id: attemptId,
          effectId: effect.id,
          attemptNo,
          intentId: input.intentId,
          epoch: input.token.epoch,
          state: 'prepared',
          candidateId: input.candidateId,
          requestHash: input.requestHash,
          recoveryClass: input.recoveryClass,
          recoveryDescriptorJson,
          classifierVersion: input.classifierVersion,
          transportPolicyVersion: input.transportPolicyVersion,
          retryAuthority: input.retryAuthority,
          preparedAt: now,
          updatedAt: now,
        })
        .run()
      for (const fenceKey of resources) {
        try {
          await tx
            .insert(taskExecutionEffectFences)
            .values({
              effectAttemptId: attemptId,
              fenceKey,
              acquiredEpoch: input.token.epoch,
              acquiredAt: now,
            })
            .run()
        } catch (error) {
          // 驱动错误形状经能力矩阵归类：PG 的 SQLSTATE 23505（`errno` 或 `code`）与 SQLite 的
          // `SQLITE_CONSTRAINT_UNIQUE` / `UNIQUE constraint failed` 都归 'unique-violation'。
          if (engineOf(tx).classifyError(error) !== 'unique-violation') throw error
          throw new TaskExecutionError(
            'task-execution-resource-conflict',
            `resource '${fenceKey}' is already held by another acting effect`,
            { resourceKey: fenceKey },
          )
        }
      }
      const acting = await tx
        .update(taskExecutionEffectAttempts)
        .set({ state: 'acting', actingAt: now, updatedAt: now })
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, attemptId),
            eq(taskExecutionEffectAttempts.state, 'prepared'),
          ),
        )
        .returning({ id: taskExecutionEffectAttempts.id })
      const advanced = await tx
        .update(taskExecutionEffects)
        .set({ lastAttemptNo: attemptNo, currentIntentId: input.intentId, updatedAt: now })
        .where(
          and(
            eq(taskExecutionEffects.id, effect.id),
            eq(taskExecutionEffects.state, 'open'),
            eq(taskExecutionEffects.lastAttemptNo, attemptNo - 1),
          ),
        )
        .returning({ id: taskExecutionEffects.id })
      if (acting[0] === undefined || advanced[0] === undefined) {
        throw new TaskExecutionError('task-execution-stale-owner', 'effect preparation CAS lost')
      }
      return { effectId: effect.id, attemptId, attemptNo, resourceKeys: resources }
    })
  }

  private async settleTx(
    tx: TaskExecutionTransaction,
    input: TaskEffectAttemptSettlement,
    projection?: CodeHostNodeSettlementProjection,
  ): Promise<void> {
    if (input.state === 'outcome-unknown') {
      throw new TaskExecutionError(
        'task-execution-recovery-required',
        'outcome-unknown requires a task-wide quiescence closure; ordinary worker settlement may only mark recovery-required',
      )
    }
    const now = input.now ?? Date.now()
    await assertTaskOwnerTx(tx, input.token, now)
    const attemptRows = await tx
      .select()
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.id, input.attemptId))
      .limit(1)
    const effectRows = await tx
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.id, input.effectId))
      .limit(1)
    const attempt = attemptRows[0]
    const effect = effectRows[0]
    if (
      attempt === undefined ||
      effect === undefined ||
      attempt.effectId !== effect.id ||
      effect.taskId !== input.token.taskId ||
      attempt.epoch !== input.token.epoch
    ) {
      throw new TaskExecutionError(
        'task-execution-stale-owner',
        `effect attempt '${input.attemptId}' is not owned by the current epoch`,
      )
    }
    assertAttemptTransition(attempt.state, input.state)
    const receiptJson = bounded(input.receiptJson)
    const changed = await tx
      .update(taskExecutionEffectAttempts)
      .set({
        state: input.state,
        applicationEvidence: input.applicationEvidence,
        retryAuthority: input.retryAuthority,
        receiptJson,
        failureCode: input.failureCode ?? null,
        settledAt:
          input.state === 'recovery-required' || input.state === 'retry-authorized' ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskExecutionEffectAttempts.id, attempt.id),
          eq(taskExecutionEffectAttempts.state, attempt.state),
          eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
        ),
      )
      .returning({ id: taskExecutionEffectAttempts.id })
    if (changed[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'effect settlement CAS lost')
    }
    if (input.state === 'retry-authorized') {
      // 授权放行的下一次发送不再需要这一 attempt 的 hold。
      await this.releaseFences(tx, attempt.id, input.token.epoch, now)
      if (projection !== undefined) await applyCodeHostProjection(tx, projection)
      return
    }
    if (input.state === 'recovery-required') {
      if (projection !== undefined) await applyCodeHostProjection(tx, projection)
      return
    }
    const attempts = await tx
      .select({
        attemptNo: taskExecutionEffectAttempts.attemptNo,
        state: taskExecutionEffectAttempts.state,
        applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
      })
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
      .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
    const evidence: AttemptEvidence[] = attempts.map((row) => {
      if (row.applicationEvidence === null) {
        throw new Error(`attempt '${effect.id}/${row.attemptNo}' lacks application evidence`)
      }
      return {
        attemptNo: row.attemptNo,
        state: row.state,
        applicationEvidence: row.applicationEvidence,
      }
    })
    const outcome = aggregateEffectOutcome(evidence)
    if (outcome.state === 'outcome-unknown') {
      // 先前的含糊加上后来的确定失败仍然是未知。留一个未结算的 attempt / hold，
      // 让带证明的任务级清算才能终结这一代。
      await tx
        .update(taskExecutionEffectAttempts)
        .set({
          state: 'recovery-required',
          settledAt: null,
          failureCode: input.failureCode ?? 'aggregate-outcome-unknown',
          updatedAt: now,
        })
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, attempt.id),
            eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
          ),
        )
        .run()
      if (projection !== undefined) await applyCodeHostProjection(tx, projection)
      return
    }
    await this.releaseFences(tx, attempt.id, input.token.epoch, now)
    const logicalReceipt = JSON.stringify({
      v: 1,
      appliedAttemptNo: outcome.appliedAttemptNo,
      priorAmbiguityCount: outcome.priorAmbiguityCount,
      lastAttemptReceipt: receiptJson === null ? null : JSON.parse(receiptJson),
    })
    const effectChanged = await tx
      .update(taskExecutionEffects)
      .set({
        state: outcome.state,
        receiptJson: logicalReceipt,
        failureCode: input.failureCode ?? null,
        settledAt: now,
        updatedAt: now,
      })
      .where(and(eq(taskExecutionEffects.id, effect.id), eq(taskExecutionEffects.state, 'open')))
      .returning({ id: taskExecutionEffects.id })
    if (effectChanged[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'effect terminal CAS lost')
    }
    const watermarkRows = await tx
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, effect.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, effect.operationFamilyKey),
        ),
      )
      .limit(1)
    const watermark = watermarkRows[0]
    if ((watermark?.highestSettledGeneration ?? -1) > effect.operationGeneration) {
      throw new Error('operation generation regressed below retained watermark')
    }
    if (
      watermark !== undefined &&
      watermark.highestSettledGeneration === effect.operationGeneration &&
      (watermark.requestHash !== effect.requestHash ||
        watermark.slotPathDigest !== effect.slotPathDigest)
    ) {
      throw new Error('operation generation digest differs from retained watermark')
    }
    if (watermark === undefined) {
      await tx
        .insert(taskExecutionLineageOperationRecords)
        .values({
          id: ulid(),
          recordKind: 'generation-watermark',
          executionLineageId: effect.executionLineageId,
          operationFamilyKey: effect.operationFamilyKey,
          operationGeneration: null,
          highestSettledGeneration: effect.operationGeneration,
          lastOutcome: outcome.state,
          requestHash: effect.requestHash,
          slotPathJson: effect.slotPathJson,
          slotPathDigest: effect.slotPathDigest,
          rootAnchorTaskId: effect.taskId,
          currentAnchorTaskId: effect.taskId,
          recordRevision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    } else {
      const advanced = await tx
        .update(taskExecutionLineageOperationRecords)
        .set({
          highestSettledGeneration: Math.max(
            watermark.highestSettledGeneration ?? -1,
            effect.operationGeneration,
          ),
          lastOutcome: outcome.state,
          requestHash: effect.requestHash,
          slotPathJson: effect.slotPathJson,
          slotPathDigest: effect.slotPathDigest,
          currentAnchorTaskId: effect.taskId,
          recordRevision: watermark.recordRevision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskExecutionLineageOperationRecords.id, watermark.id),
            eq(taskExecutionLineageOperationRecords.recordRevision, watermark.recordRevision),
          ),
        )
        .returning({ id: taskExecutionLineageOperationRecords.id })
      if (advanced[0] === undefined) {
        throw new TaskExecutionError('task-execution-stale-owner', 'effect watermark CAS lost')
      }
    }
    if (projection !== undefined) await applyCodeHostProjection(tx, projection)
  }

  /** 只释放这一枚不可变 attempt 在本 epoch 里持有的围栏。 */
  private async releaseFences(
    tx: TaskExecutionTransaction,
    attemptId: string,
    epoch: number,
    now: number,
  ): Promise<void> {
    await tx
      .update(taskExecutionEffectFences)
      .set({ releasedAt: now })
      .where(
        and(
          eq(taskExecutionEffectFences.effectAttemptId, attemptId),
          isNull(taskExecutionEffectFences.releasedAt),
          eq(taskExecutionEffectFences.acquiredEpoch, epoch),
        ),
      )
      .run()
  }

  async settle(input: TaskEffectAttemptSettlement): Promise<void> {
    await withTaskExecutionSerializable(this.db, async (tx) => await this.settleTx(tx, input))
  }

  /** 用例专属原子：effect 结算与评审回滚投影共用一笔事务，刻意不进通用 effect 端口。 */
  async settleGateRollback(input: GateRollbackSettlement): Promise<void> {
    if (input.outcome.kind === 'threw') {
      await this.settle({
        token: input.token,
        effectId: input.effectId,
        attemptId: input.attemptId,
        state: 'recovery-required',
        applicationEvidence: 'ambiguous',
        retryAuthority: 'none',
        receiptJson: JSON.stringify({
          v: 1,
          operationId: input.operationId,
          planDigest: input.planDigest,
          error: input.outcome.error,
        }),
        failureCode: 'human-gate-workspace-rollback-threw',
      })
      return
    }
    const outcome = input.outcome
    await withTaskExecutionSerializable(this.db, async (tx) => {
      await this.settleTx(tx, {
        token: input.token,
        effectId: input.effectId,
        attemptId: input.attemptId,
        state: outcome.applicationEvidence === 'applied' ? 'succeeded' : 'failed-not-applied',
        applicationEvidence: outcome.applicationEvidence,
        retryAuthority: 'none',
        receiptJson: JSON.stringify({
          v: 1,
          operationId: input.operationId,
          planDigest: input.planDigest,
          rolledBack: outcome.rolledBack,
          outcome: outcome.receipt,
        }),
        ...(outcome.rolledBack ? {} : { failureCode: 'human-gate-workspace-rollback-incomplete' }),
      })
      await applyGateRollbackProjection(tx, {
        taskId: input.token.taskId,
        operationId: input.operationId,
        sourceNodeRunIds: input.sourceNodeRunIds,
        outcome,
      })
    })
  }

  async settleCodeHostNode(
    input: Parameters<TaskExecutionEffectPersistence['settleCodeHostNode']>[0],
  ): Promise<void> {
    await withTaskExecutionSerializable(
      this.db,
      async (tx) => await this.settleTx(tx, input.settlement, input.projection),
    )
  }

  async settleWorkspacePreparation(
    input: Parameters<TaskExecutionEffectPersistence['settleWorkspacePreparation']>[0],
  ): Promise<void> {
    await withTaskExecutionSerializable(this.db, async (tx) => {
      await this.settleTx(tx, input.settlement)
      await applyWorkspacePreparationProjection(tx, input.projection)
    })
  }

  async recordProcessSpawn(
    input: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0],
  ): Promise<void> {
    const now = input.now ?? Date.now()
    await withTaskExecutionSerializable(this.db, async (tx) => {
      await assertTaskOwnerTx(tx, input.token, now)
      const attempts = await tx
        .select({
          state: taskExecutionEffectAttempts.state,
          epoch: taskExecutionEffectAttempts.epoch,
          taskId: taskExecutionEffects.taskId,
        })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, input.attemptId),
            eq(taskExecutionEffectAttempts.effectId, input.effectId),
          ),
        )
        .limit(1)
      const attempt = attempts[0]
      if (
        attempt === undefined ||
        attempt.state !== 'acting' ||
        attempt.epoch !== input.token.epoch ||
        attempt.taskId !== input.token.taskId
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `process attempt '${input.attemptId}' receipt was fenced`,
        )
      }
      const updated = await tx
        .update(taskExecutionEffectAttempts)
        .set({
          receiptJson: JSON.stringify({
            v: 1,
            phase: 'spawn-receipt',
            pid: input.pid,
            spawnBinaryPath: input.spawnBinaryPath,
            launchNonce: input.launchNonce,
          }),
          updatedAt: now,
        })
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, input.attemptId),
            eq(taskExecutionEffectAttempts.state, 'acting'),
            eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
          ),
        )
        .returning({ id: taskExecutionEffectAttempts.id })
      const projected = await tx
        .update(nodeRuns)
        .set({
          pid: input.pid,
          spawnBinaryPath: input.spawnBinaryPath,
          spawnLaunchNonce: input.launchNonce,
          ...(input.runtimeParamsJson === undefined
            ? {}
            : { runtimeParamsJson: input.runtimeParamsJson }),
        })
        .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.taskId, input.token.taskId)))
        .returning({ id: nodeRuns.id })
      if (updated[0] === undefined || projected[0] === undefined) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          'process spawn projection CAS lost',
        )
      }
    })
  }

  // RFC-359 T7b：静默清算是一份实现（effectQuiescence.ts），端口只是委托。
  async unresolvedEffectIds(taskId: string): Promise<readonly string[]> {
    return await readUnresolvedEffectIds(this.db, taskId)
  }

  async unreapedProcessCode(taskId: string): Promise<string | null> {
    return await readUnreapedProcessCode(this.db, taskId)
  }

  async resolveQuiescedManagedProcesses(
    input: Parameters<TaskExecutionEffectPersistence['resolveQuiescedManagedProcesses']>[0],
  ) {
    return await resolveQuiescedManagedProcesses(this.db, input)
  }

  async closeOutcomeUnknownAndRelease(
    input: Parameters<TaskExecutionEffectPersistence['closeOutcomeUnknownAndRelease']>[0],
  ) {
    return await closeOutcomeUnknownAndRelease(this.db, input)
  }
}
