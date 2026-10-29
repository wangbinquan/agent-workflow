import { isMergeStateSettled } from '@agent-workflow/shared'
import { compareLegacyNodeRunMintOrder } from './legacyOrder'
import { pickFreshestRun, pickReusableShardRun } from './legacyPickers'
import type {
  LegacyRunSeq,
  RunRef,
  ShardSetView,
  WrapperSlotRef,
} from '../../../application/ports/runSelection'
import { decodeConsumedEdges } from './consumed'
import { oracleSlotRows } from './pickers'
import { oracleRunRef, oracleSelectedRun, type OracleRunRow } from './rows'

export function oracleShardSet(
  rows: readonly OracleRunRow[],
  wrapper: WrapperSlotRef,
): ShardSetView<LegacyRunSeq> {
  for (const row of rows) void row.seq
  const forced = wrapper.processRetryIndex !== undefined
  const participating: RunRef<LegacyRunSeq>[] = []
  const shards = wrapper.shards.map((request) => {
    const slot = {
      kind: 'shard' as const,
      nodeId: request.nodeId,
      iteration: wrapper.iteration,
      shardKey: request.shardKey,
    }
    const candidates = oracleSlotRows(rows, slot)
    const current = pickFreshestRun(candidates, { topLevelOnly: false })
    // 聚合输入与派发复用共用旧 picker，但聚合输入没有 newest-id / reuseDisabled 条件。
    const input = pickReusableShardRun(candidates, request)
    if (input !== undefined) participating.push(oracleRunRef(input, rows, slot))
    const reusable = forced || wrapper.reuseDisabled === true ? undefined : input
    const merged = candidates.filter((row) => row.status === 'done' && row.mergeState === 'merged')
    return {
      slot,
      current: current === undefined ? null : oracleSelectedRun(current, rows, slot),
      reusable: reusable === undefined ? null : oracleRunRef(reusable, rows, slot),
      replayable:
        reusable !== undefined &&
        reusable.id === current?.id &&
        (isMergeStateSettled(reusable.mergeState) || reusable.mergeState === 'conflict-human'),
      rerunInPlace:
        !forced &&
        current !== undefined &&
        current.status !== 'done' &&
        current.parentNodeRunId === wrapper.wrapperRunId,
      singleMergedCandidate: merged.length === 1 ? oracleRunRef(merged[0]!, rows, slot) : null,
    }
  })
  const slot =
    wrapper.aggregatorNodeId === undefined
      ? undefined
      : {
          kind: 'aggregator' as const,
          nodeId: wrapper.aggregatorNodeId,
          iteration: wrapper.iteration,
        }
  const aggregator =
    slot === undefined
      ? undefined
      : pickFreshestRun(oracleSlotRows(rows, slot), { topLevelOnly: false })
  const newer =
    aggregator !== undefined &&
    participating.every((row) => compareLegacyNodeRunMintOrder(aggregator, row) > 0)
  return {
    shards,
    participating,
    aggregator: aggregator === undefined ? null : oracleSelectedRun(aggregator, rows, slot),
    aggregatorInputs: decodeConsumedEdges(aggregator?.consumedUpstreamRunsJson),
    aggregatorInputEvidence:
      decodeConsumedEdges(aggregator?.consumedUpstreamRunsJson).length === 0
        ? 'unrecorded'
        : 'source-node',
    aggregatorNewerThanInputs: newer,
    aggregatorReplayable:
      !forced &&
      wrapper.reuseDisabled !== true &&
      aggregator !== undefined &&
      aggregator.status === 'done' &&
      newer &&
      (isMergeStateSettled(aggregator.mergeState) || aggregator.mergeState === 'conflict-human'),
    aggregatorRerunInPlace:
      !forced &&
      aggregator !== undefined &&
      aggregator.status !== 'done' &&
      aggregator.parentNodeRunId === wrapper.wrapperRunId,
  }
}
