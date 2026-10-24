import { createHumanGatePersistenceParticipantInTx } from './humanGatePersistenceParticipant'
// RFC-359 W4-D25 —— human-gate 停靠原子：一份实现，两个引擎共用。
//
// 合一前 `sqliteHumanGateTaskLifecyclePersistence.ts` 与 `postgresqlHumanGateTaskLifecyclePersistence.ts`
// 各一份（相似度 0.50），差别只在三处：事务原语（dbTxSync ↔ PG serializable）、owner 围栏
// （ownership store 的库外预读 ↔ 事务内 assert）与停靠候选行的读法。现在三处都取中立原语：
//   * `withTaskExecutionSerializable` —— SQLite 是 BEGIN IMMEDIATE（本来就全库独占），PG 抬到
//     SERIALIZABLE 并按 40001 重放；合一没有改任一引擎的隔离级别。
//   * `assertTaskOwnerTx` / `assertTaskOwnerlessTx` —— 「有 token 按 owner、没有按无主」同一条围栏，
//     且从库外预读挪进**同一笔事务**，两个引擎都不再有「读完到写之间被人认领」的窗口。
//   * `transitionHumanGateTask` —— 蓝本是 SQLite 跑了最久的 `transitionHumanGateTaskTx`，错误类
//     （NotFoundError / ConcurrentTaskTransition / ConflictError）逐条保留。
//
// collaboration 侧的投影由 `DatabaseHumanGateOpenParticipantInTx` 在同一笔事务里完成；本文件只
// 负责任务生命周期 CAS、围栏与提交后的事件发布。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { DatabaseHumanGateOpenParticipantInTx } from '@/modules/collaboration/infrastructure/humanGateOpenParticipant'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { committedEventGroupId } from '@/platform/events/committed/types'
import type {
  HumanGateTaskLifecycle,
  HumanGateTaskParkResult,
} from '../application/ports/humanGateTaskLifecycle'
import type { OwnershipToken } from '../domain/ownership'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { transitionHumanGateTask } from './humanGateTaskTransition'
import { createNodeRunLifecycleParticipantInTx } from './nodeRunLifecyclePersistence'
import { createNodeRunMintParticipantInTx } from './nodeRunMintParticipant'
import { createConsumedInputsParticipantInTx } from './consumedInputsParticipant'
import {
  assertTaskOwnerTx,
  assertTaskOwnerlessTx,
  withTaskExecutionSerializable,
  type TaskExecutionTransaction,
} from './ownedTaskExecution'
import type { DrizzleTaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'

class ManualQuestionPending extends Error {}

const journal = new DatabaseHumanGateOperationJournal(createHumanGatePersistenceParticipantInTx)

/** 「有 token 就按 owner 围栏，没有就按无主围栏」——与合一前两侧同一条判据，只是挪进了同一笔事务。 */
async function fence(
  tx: TaskExecutionTransaction,
  taskId: string,
  token: OwnershipToken | undefined,
  now: number,
): Promise<void> {
  if (token === undefined) {
    await assertTaskOwnerlessTx(tx, taskId)
    return
  }
  await assertTaskOwnerTx(tx, token, now)
}

/**
 * 停靠按哪个任务修订号做 CAS。
 *
 * 门在准备时记下当时读到的修订号；同一波里两个提问方几乎同时收尾时，先停靠的那个把任务
 * running→awaiting_human、修订号加一，后一个拿着旧修订号停靠就会被判「修订号已变」而丢掉整轮问题
 * （rfc333-sibling-gate-park.test.ts）。带 owner token 的停靠已经在同一笔事务里过了 owner 围栏
 * （ownerId + daemon 代际 + epoch + claimed），那才是执行代际的判据——所以按任务**此刻**的修订号
 * 跃迁：兄弟门已停靠就合流，被决定放回 running 就重新停靠，离开运行生命周期的任务仍由
 * `transitionHumanGateTask` 的合法源状态拒绝。无主停靠没有别的围栏，准备时的修订号仍是唯一判据。
 */
async function parkRevision(
  tx: TaskExecutionTransaction,
  input: Parameters<HumanGateTaskLifecycle['parkPrepared']>[0],
): Promise<number> {
  if (input.token === undefined) return input.prepared.expectedTaskRevision
  const { tasks } = tablesOf(tx)
  const row = (
    await tx
      .select({ lifecycleEventRevision: tasks.lifecycleEventRevision })
      .from(tasks)
      .where(eq(tasks.id, input.prepared.taskId))
      .limit(1)
  )[0]
  return row?.lifecycleEventRevision ?? input.prepared.expectedTaskRevision
}

function gatesIn(tx: TaskExecutionTransaction): DatabaseHumanGateOpenParticipantInTx {
  return new DatabaseHumanGateOpenParticipantInTx(
    tx,
    journal,
    createNodeRunMintParticipantInTx(tx),
    createNodeRunLifecycleParticipantInTx(tx),
    createConsumedInputsParticipantInTx(),
  )
}

export class DatabaseHumanGateTaskLifecyclePersistence implements HumanGateTaskLifecycle {
  constructor(
    private readonly db: PersistenceDb,
    private readonly runtimeLifecycle: DrizzleTaskRuntimeLifecyclePersistence,
  ) {}

  async parkPrepared(
    input: Parameters<HumanGateTaskLifecycle['parkPrepared']>[0],
  ): Promise<HumanGateTaskParkResult> {
    if (
      input.prepared.taskId.length === 0 ||
      input.prepared.expectedTaskRevision < 0 ||
      input.prepared.manifestDigest.length === 0 ||
      (input.token !== undefined && input.token.taskId !== input.prepared.taskId)
    ) {
      throw new Error('prepared-human-gate-task-or-manifest-mismatch')
    }
    const result = await withTaskExecutionSerializable(this.db, async (tx) => {
      await fence(tx, input.prepared.taskId, input.token, input.now)
      const consumed = await gatesIn(tx).consumePreparedGateTx({
        prepared: input.prepared,
        taskRevision: input.prepared.expectedTaskRevision,
        now: input.now,
      })
      if (consumed.gate.kind !== input.prepared.gateKind) {
        throw new Error('prepared-human-gate-kind-mismatch')
      }
      const parked = await transitionHumanGateTask(tx, {
        taskId: input.prepared.taskId,
        expectedTaskRevision: await parkRevision(tx, input),
        transition: consumed.gate.kind === 'review' ? 'park-review' : 'park-human',
        now: input.now,
        committedEventIdentity: {
          operationRef: input.prepared.operationId,
          eventGroupId: committedEventGroupId('collaboration', input.prepared.operationId),
          eventGroupOrdinal: 0,
        },
      })
      return {
        taskRevision: parked.taskRevision,
        gateRevision: consumed.gateRevision,
        nodeProjectionDigest: consumed.nodeProjectionDigest,
        committedEventRef: consumed.committedEventRef,
        eventRefs: [...parked.eventRefs, ...consumed.eventRefs],
      }
    })
    await publishCommittedEventsAfterCommit(result.eventRefs)
    return result
  }

  async settleManualQuestionParks(
    input: Parameters<HumanGateTaskLifecycle['settleManualQuestionParks']>[0],
  ): ReturnType<HumanGateTaskLifecycle['settleManualQuestionParks']> {
    const result = await withTaskExecutionSerializable(this.db, async (tx) => {
      await fence(tx, input.taskId, input.token, input.now)
      const { tasks } = tablesOf(tx)
      const task = (
        await tx
          .select({ status: tasks.status, lifecycleEventRevision: tasks.lifecycleEventRevision })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .limit(1)
      )[0]
      const empty = {
        parked: false,
        taskRevision: null as number | null,
        operationIds: [] as readonly string[],
        eventRefs: [] as readonly TaskExecutionPostCommitEventRef[],
      }
      if (
        task === undefined ||
        (task.status !== 'pending' && task.status !== 'running' && task.status !== 'awaiting_human')
      ) {
        return empty
      }
      const gates = gatesIn(tx)
      const operationIds = await gates.listPreparedManualQuestionParksTx(input.taskId)
      if (operationIds.length === 0) {
        return { ...empty, taskRevision: task.lifecycleEventRevision, operationIds }
      }
      let outstanding = false
      for (const operationId of operationIds) {
        const consumed = await gates.consumeManualQuestionParkTx({
          operationId,
          taskId: input.taskId,
          now: input.now,
        })
        outstanding ||= consumed.outstanding
      }
      if (!outstanding) {
        return { ...empty, taskRevision: task.lifecycleEventRevision, operationIds }
      }
      const parked = await transitionHumanGateTask(tx, {
        taskId: input.taskId,
        expectedTaskRevision: task.lifecycleEventRevision,
        transition: 'park-human',
        now: input.now,
      })
      return {
        parked: true,
        taskRevision: parked.taskRevision,
        operationIds,
        eventRefs: parked.eventRefs,
      }
    })
    if (result.eventRefs.length > 0) await publishCommittedEventsAfterCommit(result.eventRefs)
    return result
  }

  async trySetWhenNoManualQuestionParks(
    input: Parameters<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']>[0],
  ): ReturnType<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']> {
    try {
      const won = await this.runtimeLifecycle.trySetWithGuard(input, async (tx) => {
        const pending = await gatesIn(tx).listPreparedManualQuestionParksTx(input.taskId)
        if (pending.length > 0) throw new ManualQuestionPending()
      })
      return { kind: 'settled', won }
    } catch (error) {
      if (error instanceof ManualQuestionPending) return { kind: 'manual-question-pending' }
      throw error
    }
  }
}
