// Frozen branch fragments from 67ab6b9aed08d97dcd6d3d9dfb57b8885a11f8e6:wrapperMechanics.ts.
// Only the branch bodies (side effects) are replaced with observations. Conditions and
// picker bindings are copied from HEAD; all executable dependencies below are frozen too.
import type { MergeState } from '@agent-workflow/shared'
import { compareNodeRunMintOrder } from './order'
import { isFresherNodeRun, pickFreshestRun, pickReusableShardRun } from './pickers'

export function isMergeStateSettled(s: string | null | undefined): boolean {
  return (s ?? null) === null || s === 'merged'
}

export interface FrozenFanoutRow {
  readonly id: string
  readonly seq: number | null
  readonly nodeId: string
  readonly iteration: number
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
  readonly shardValueHash: string | null
  readonly status: string
  readonly mergeState: string | null
}
interface FrozenDispatch {
  readonly wrapperRunId: string
  readonly iteration: number
  readonly reuseDisabled?: boolean
  readonly processRetryIndex?: number
}
export function frozenShardDecision<R extends FrozenFanoutRow>(
  rows: readonly R[],
  args: FrozenDispatch & {
    readonly nodeId: string
    readonly shardKey: string | null
    readonly valueHash: string | null
  },
) {
  const { wrapperRunId, iteration, nodeId, valueHash } = args
  const rowShardKey = args.shardKey
  const candidates = rows
    .filter(
      (row) => row.nodeId === nodeId && row.iteration === iteration && row.parentNodeRunId !== null,
    )
    .filter((row) => (row.shardKey ?? null) === rowShardKey)
  const forcedProcessRetry = args.processRetryIndex !== undefined
  const reusableNow = () =>
    args.reuseDisabled || forcedProcessRetry
      ? undefined
      : pickReusableShardRun(candidates, { shardKey: rowShardKey, valueHash })
  const freshest = pickFreshestRun(candidates, { topLevelOnly: false })
  const reusable = reusableNow()
  const doneMergedCandidates = candidates.filter(
    (c) => c.status === 'done' && c.mergeState === ('merged' satisfies MergeState),
  )
  let replay = false
  if (
    !forcedProcessRetry &&
    freshest !== undefined &&
    reusable !== undefined &&
    reusable.id === freshest.id &&
    (isMergeStateSettled(reusable.mergeState) || reusable.mergeState === 'conflict-human')
  ) {
    replay = true
  }
  let rerunInPlace = false
  if (
    !forcedProcessRetry &&
    freshest !== undefined &&
    freshest.status !== 'done' &&
    freshest.parentNodeRunId === wrapperRunId
  ) {
    rerunInPlace = true
  }
  return {
    current: freshest?.id,
    reusable: reusable?.id,
    input: pickReusableShardRun(candidates, { shardKey: rowShardKey, valueHash }),
    replayable: replay,
    rerunInPlace,
    singleMergedCandidate:
      doneMergedCandidates.length === 1 ? doneMergedCandidates[0]!.id : undefined,
  }
}
export function frozenAggregatorDecision<R extends FrozenFanoutRow>(
  rows: readonly R[],
  participatingRows: readonly R[],
  args: FrozenDispatch & { readonly nodeId: string },
) {
  const { wrapperRunId, iteration, nodeId } = args
  const candidates = rows
    .filter(
      (row) => row.nodeId === nodeId && row.iteration === iteration && row.parentNodeRunId !== null,
    )
    .filter((row) => row.shardKey === null)
  const freshestAgg = pickFreshestRun(candidates, { topLevelOnly: false })
  const forcedProcessRetry = args.processRetryIndex !== undefined
  const replayable = (row: typeof freshestAgg): row is NonNullable<typeof freshestAgg> =>
    !forcedProcessRetry &&
    !args.reuseDisabled &&
    row !== undefined &&
    row.status === 'done' &&
    participatingRows.every((participating) => isFresherNodeRun(row, participating))
  let replay = false
  if (
    replayable(freshestAgg) &&
    (isMergeStateSettled(freshestAgg.mergeState) || freshestAgg.mergeState === 'conflict-human')
  ) {
    replay = true
  }
  let rerunInPlace = false
  if (
    !forcedProcessRetry &&
    freshestAgg !== undefined &&
    freshestAgg.status !== 'done' &&
    freshestAgg.parentNodeRunId === wrapperRunId
  ) {
    rerunInPlace = true
  }
  return {
    current: freshestAgg?.id,
    replayable: replay,
    rerunInPlace,
    newerThanInputs:
      freshestAgg !== undefined &&
      participatingRows.every((row) => compareNodeRunMintOrder(freshestAgg, row) > 0),
  }
}
