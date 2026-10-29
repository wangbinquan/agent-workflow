import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { frozenTablesOf } from '@/platform/persistence/migration/epoch1/tables'
import type { LegacyRunSeq, RunSelectionReader } from '../../../application/ports/runSelection'
import { decodeConsumedEdges } from './consumed'
import { createRunSelectionOracleSnapshot } from './snapshot'

/** 两 provider 共用现有 node_runs；正常读没有缓存，事务快照由绑定句柄拥有。 */
export function createRunSelectionReader(db: PersistenceDb): RunSelectionReader<LegacyRunSeq> {
  async function snapshot(taskId: string): Promise<RunSelectionReader<LegacyRunSeq>> {
    const { nodeRuns: r } = frozenTablesOf(db)
    const rows = await db
      .select({
        id: r.id,
        taskId: r.taskId,
        nodeId: r.nodeId,
        seq: r.seq,
        status: r.status,
        retryIndex: r.retryIndex,
        iteration: r.iteration,
        parentNodeRunId: r.parentNodeRunId,
        containerRunId: r.containerRunId,
        shardKey: r.shardKey,
        shardValueHash: r.shardValueHash,
        reviewIteration: r.reviewIteration,
        wgRound: r.wgRound,
        rerunCause: r.rerunCause,
        wrapperProgressJson: r.wrapperProgressJson,
        consumedUpstreamRunsJson: r.consumedUpstreamRunsJson,
        childTaskId: r.childTaskId,
        startedAt: r.startedAt,
        mergeState: r.mergeState,
        supersededByReview: r.supersededByReview,
      })
      .from(r)
      .where(eq(r.taskId, taskId))
    return createRunSelectionOracleSnapshot(rows)
  }
  return {
    async revision() {
      throw new Error('epoch1-oracle-has-no-selection-revision')
    },
    async current(taskId, slot) {
      return (await snapshot(taskId)).current(taskId, slot)
    },
    async currentInFrame(taskId, frame) {
      return (await snapshot(taskId)).currentInFrame(taskId, frame)
    },
    async shardSet(taskId, wrapper) {
      return (await snapshot(taskId)).shardSet(taskId, wrapper)
    },
    async slotHistory(taskId, slot, filter) {
      return (await snapshot(taskId)).slotHistory(taskId, slot, filter)
    },
    async familyHistory(taskId, family, filter) {
      return (await snapshot(taskId)).familyHistory(taskId, family, filter)
    },
    async consumed(runId) {
      const { nodeRuns } = frozenTablesOf(db)
      const [row] = await db
        .select({ json: nodeRuns.consumedUpstreamRunsJson })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, runId))
        .limit(1)
      return decodeConsumedEdges(row?.json)
    },
  }
}
