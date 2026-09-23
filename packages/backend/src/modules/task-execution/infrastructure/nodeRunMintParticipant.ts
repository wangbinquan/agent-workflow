// RFC-359 W47 —— one node-run mint program, driven by the existing sync/async entries.
// The callers retain transaction ownership.

import { eq } from 'drizzle-orm'

import { nodeRuns, tasks } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import {
  driveAsyncProgram,
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import {
  buildNodeRunMintRecord,
  nodeRunLineageColumns,
} from '../application/buildNodeRunMintRecord'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import { childScopePath } from '../domain/environmentChain'

/** 在调用方已持有的事务里铸造 node_runs 行。 */
export interface NodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): Promise<string>
}

/**
 * One mint sequence: scope / lineage resolution, then the insert.
 *
 * RFC-369 —— 这里**不再**读同帧旧代、也不再把它们标成 abandoned。那次范围读在 PostgreSQL
 * SERIALIZABLE 下按索引页加谓词锁，同一任务里的任意两次并发铸造几乎必然互判读写依赖、其一被中止
 * （工作组领队 / 成员并发时 CI 上间歇红，本地实验去掉后 8→0 次冲突）。「旧代作废」改由读侧按同一
 * 判据推导：merge 状态机迁移（`mergeStateLifecyclePersistence.ts`）与入口重放
 * （`executionMergeRecovery.ts`），判据见 `domain/nodeRunSupersession.ts`。
 */
export function* nodeRunMintProgram(
  tx: DatabaseTransaction,
  input: NodeRunMintInput,
): Generator<TransactionProgramStep, string, void> {
  const record = buildNodeRunMintRecord(input)
  // RFC-354 — derive the breadcrumb from the generation row this row hangs
  // off; the record carries null exactly when the caller left it to us.
  let scopePath = record.scopePath
  if (scopePath === null) {
    const container =
      record.containerRunId === null
        ? undefined
        : yield* transactionStep(() =>
            tx
              .select({ nodeId: nodeRuns.nodeId, scopePath: nodeRuns.scopePath })
              .from(nodeRuns)
              .where(eq(nodeRuns.id, record.containerRunId!))
              .get(),
          )
    scopePath =
      container === undefined
        ? ''
        : childScopePath(container.scopePath, container.nodeId, record.iteration)
  }
  // RFC-359 W6 —— 两个 lineage 列必须由**插入点显式写出**。此前它们在 SQLite 上由迁移 0210 的
  // 触发器补齐、PostgreSQL 上留 null（那个触发器已随迁移 0224 退役）；推导现在两个引擎共用
  // 一份，见 `nodeRunLineageColumns` 的头注释。
  const lineage = nodeRunLineageColumns(
    record,
    record.lineageSlotPathJson !== null
      ? undefined
      : yield* transactionStep(() =>
          tx
            .select({
              lineageSlotPathJson: tasks.lineageSlotPathJson,
              workflowVersion: tasks.workflowVersion,
            })
            .from(tasks)
            .where(eq(tasks.id, record.taskId))
            .get(),
        ),
  )
  const values = {
    ...record,
    scopePath,
    continuationSlotKey: lineage.continuationSlotKey,
    lineageSlotPathJson: lineage.lineageSlotPathJson,
  }
  yield* transactionStep(() => tx.insert(nodeRuns).values(values).run())
  return values.id
}

export function createNodeRunMintParticipantInTx(
  tx: DatabaseTransaction,
): NodeRunMintParticipantInTx {
  return Object.freeze({
    async mint(input: NodeRunMintInput) {
      return driveAsyncProgram(nodeRunMintProgram(tx, input), (step) => step())
    },
  })
}
