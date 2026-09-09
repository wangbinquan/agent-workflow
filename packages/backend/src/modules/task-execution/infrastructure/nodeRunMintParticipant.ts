// RFC-359 W47 —— one node-run mint program, driven by the existing sync/async entries.
// The callers retain transaction ownership and their original prior-row read terminal.

import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'

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

const ABANDONABLE_MERGE_STATES = [
  'isolating',
  'pending-merge',
  'conflict-agent',
  'conflict-human',
] as const

/** 在调用方已持有的事务里铸造 node_runs 行。 */
export interface NodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): Promise<string>
}

type PriorRows = Array<Pick<typeof nodeRuns.$inferSelect, 'id'>>
type ReadPriorRows = (
  query: PromiseLike<PriorRows> & { all(): PriorRows | PromiseLike<PriorRows> },
) => PriorRows | PromiseLike<PriorRows>

/** One mint sequence; each existing entry retains its own prior-row terminal. */
export function* nodeRunMintProgram(
  tx: DatabaseTransaction,
  input: NodeRunMintInput,
  readPriorRows: ReadPriorRows,
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
  // Prior generations of the SAME frame are superseded by this mint. The frame is part of
  // the key: a nested loop's round-0 row under outer round 1 must never abandon the round-0
  // row under outer round 0.
  const priorRows = yield* transactionStep(() =>
    readPriorRows(
      tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, values.taskId),
            eq(nodeRuns.nodeId, values.nodeId),
            eq(nodeRuns.iteration, values.iteration),
            values.containerRunId === null
              ? isNull(nodeRuns.containerRunId)
              : eq(nodeRuns.containerRunId, values.containerRunId),
            isNull(nodeRuns.parentNodeRunId),
            lt(nodeRuns.id, values.id),
            ...(values.shardKey === null ? [] : [eq(nodeRuns.shardKey, values.shardKey)]),
          ),
        ),
    ),
  )
  const priorIds = priorRows.map((row) => row.id)
  if (priorIds.length > 0) {
    yield* transactionStep(() =>
      tx
        .update(nodeRuns)
        .set({ mergeState: 'abandoned' })
        .where(
          and(
            eq(nodeRuns.taskId, values.taskId),
            inArray(nodeRuns.mergeState, [...ABANDONABLE_MERGE_STATES]),
            or(inArray(nodeRuns.id, priorIds), inArray(nodeRuns.parentNodeRunId, priorIds)),
          ),
        )
        .run(),
    )
  }
  yield* transactionStep(() => tx.insert(nodeRuns).values(values).run())
  return values.id
}

export function createNodeRunMintParticipantInTx(
  tx: DatabaseTransaction,
): NodeRunMintParticipantInTx {
  return Object.freeze({
    async mint(input: NodeRunMintInput) {
      return driveAsyncProgram(
        nodeRunMintProgram(tx, input, (query) => query),
        (step) => step(),
      )
    },
  })
}
