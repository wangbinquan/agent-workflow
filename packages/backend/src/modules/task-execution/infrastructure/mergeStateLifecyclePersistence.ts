// RFC-359 W4-B1 —— node run merge_state 迁移：一份实现，两个 provider 共用；读 + CAS 写在同一事务里。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import {
  IllegalMergeStateTransition,
  nextMergeState,
  type MergeStateOrNull,
} from '@agent-workflow/shared'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import { ConflictError, NotFoundError } from '@/util/errors'
import type { MergeStateLifecyclePersistence } from '../application/ports/mergeStateLifecyclePersistence'
import { holdsExplicitTransaction } from '@/db/transactionScope'
import { isSupersedableMergeState } from '../domain/nodeRunSupersession'
import { compareAndWriteMergeStateInTx, lockNodeRunTaskRootInTx } from './nodeRunWriteProtocol'
import { createRunSelectionReader } from './runSelection/table/reader'
import {
  fenceTaskWrite,
  type TaskExecutionTransaction,
  withTaskExecutionWrite,
} from './ownedTaskExecution'

export class DrizzleMergeStateLifecyclePersistence implements MergeStateLifecyclePersistence {
  constructor(private readonly db: PersistenceDb) {}

  async transition(
    input: Parameters<MergeStateLifecyclePersistence['transition']>[0],
  ): ReturnType<MergeStateLifecyclePersistence['transition']> {
    // RFC-369 §4.2 —— 「已被更新一代取代」时收成 abandoned 并**提交**，提交之后才在事务外抛非法迁移。
    // 在调用方的外层事务帧里执行会让这次收尾随外层回滚、事务外抛也不再成立，所以直接拒绝。
    if (holdsExplicitTransaction(this.db)) {
      throw new Error(
        'merge_state transition must not run inside an enclosing transaction (RFC-369 §4.2)',
      )
    }
    const outcome = await withTaskExecutionWrite(this.db, async (tx) => {
      const { nodeRuns, nodeRunRuntimeStates } = tablesOf(tx)
      const [located] = await tx
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      if (located === undefined) {
        throw new NotFoundError('node-run-not-found', `node_run ${input.nodeRunId} not found`)
      }
      await fenceTaskWrite(tx, {
        taskId: located.taskId,
        context: input.executionContext,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
      await lockNodeRunTaskRootInTx(tx, input.nodeRunId)
      const [row] = await tx
        .select({ mergeState: nodeRunRuntimeStates.mergeState })
        .from(nodeRunRuntimeStates)
        .where(eq(nodeRunRuntimeStates.nodeRunId, input.nodeRunId))
        .limit(1)
      const from = (row?.mergeState ?? null) as MergeStateOrNull
      // RFC-369 —— 旧代作废改由这里推导（原先在铸造事务里同事务 abandon）：被更新一代取代的行再发任何
      // 非 abandon 迁移，都与今天「终态上迁移非法」同一个对外表现；这一刻把它收成 abandoned 落库。
      const superseded =
        input.event.kind !== 'abandon' &&
        isSupersedableMergeState(from) &&
        (await isRunSuperseded(tx, input.nodeRunId))
      const to: MergeStateOrNull = superseded ? 'abandoned' : nextMergeState(from, input.event)
      await compareAndWriteMergeStateInTx(
        tx,
        input.nodeRunId,
        from,
        to,
        superseded
          ? {}
          : {
              runtime:
                input.extra?.runtime === undefined
                  ? undefined
                  : {
                      isolationRootRef: input.extra.runtime.isoWorktreePath,
                      wrapperProgressJson: input.extra.runtime.wrapperProgressJson,
                    },
              checkpoint: input.extra?.checkpoint,
            },
      )
      return { from, to, superseded }
    })
    if (outcome.superseded) {
      throw new IllegalMergeStateTransition(
        'abandoned',
        input.event.kind,
        'superseded by a newer generation in the same frame (RFC-369)',
      )
    }
    return { from: outcome.from, to: outcome.to }
  }

  async tryTransition(
    input: Parameters<MergeStateLifecyclePersistence['tryTransition']>[0],
  ): Promise<boolean> {
    try {
      await this.transition(input)
      return true
    } catch (error) {
      if (
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof IllegalMergeStateTransition
      ) {
        return false
      }
      throw error
    }
  }
}

/** 本行是否被同帧更新一代结构性取代（design §3），按主键点查 + 取代谓词。 */
async function isRunSuperseded(tx: TaskExecutionTransaction, nodeRunId: string): Promise<boolean> {
  const { nodeRuns } = tablesOf(tx)
  const [run] = await tx
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  if (!run) return false
  const rows = await createRunSelectionReader(tx).familyHistory(run.taskId, { runIds: [nodeRunId] })
  return rows[0]?.structurallySuperseded ?? false
}
