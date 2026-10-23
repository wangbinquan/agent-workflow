import type { HumanGateNodeProjectionMember } from '../domain/humanGateContinuation'
import type { TaskRepositoryCheckpoint } from '../domain/taskCheckpoint'
import { encodeTaskCheckpoints } from './taskCheckpointCodec'

/**
 * `node_runs` 行 → 人工门投影成员：只保留上面那 18 个字段，逐字段同名。
 *
 * RFC-359 W57：这段此前在**五处**被逐字抄了一遍——`collaboration` 的
 * `taskQuestionDispatch.ts` / `review.ts` / `clarifyDecision.ts`，以及 `task-execution` 的
 * `sqliteTaskDecisionParticipant.ts` / `taskDecisionParticipant.ts`。它是决策路径交给
 * `humanGateNodeProjectionFence` 去算摘要的那份载荷：**给 `node_runs` 加一个决策要读的列，
 * 五处都得记得改**，漏一处的表现是该路径的围栏摘要与别处对不上。
 *
 * 形参故意收 `HumanGateNodeProjectionMember` 而不是 drizzle 的行类型：`node_runs` 的行
 * 结构上满足它（字段更多而已），而公共面因此不泄漏 ORM 的类型
 * （RFC-294 N1b 的「公共面不透明类型」判据）。
 */
export function humanGateNodeProjectionMember(
  row: HumanGateNodeProjectionMember,
): HumanGateNodeProjectionMember {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    reviewIteration: row.reviewIteration,
    status: row.status,
    failureCode: row.failureCode,
    preSnapshot: row.preSnapshot,
    preSnapshotReposJson: row.preSnapshotReposJson,
    rerunCause: row.rerunCause,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
  }
}

/** Lists rebuild the v1 fence shape; raw epoch-1 readers retain their original JSON text above. */
export function humanGateCheckpointProjectionMember(
  row: Omit<HumanGateNodeProjectionMember, 'preSnapshot' | 'preSnapshotReposJson'> & {
    readonly checkpoints: readonly TaskRepositoryCheckpoint[]
  },
  mountPaths: readonly string[],
): HumanGateNodeProjectionMember {
  const { preSnapshot, preSnapshotReposJson } = encodeTaskCheckpoints(row.checkpoints, mountPaths)
  return humanGateNodeProjectionMember({ ...row, preSnapshot, preSnapshotReposJson })
}
