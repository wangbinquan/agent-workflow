import type { NodeRunStatus } from '@agent-workflow/shared'
import type { SourceRow, TargetValue } from '@/platform/persistence/migration/conversion/types'
import type { SequencedOracleRunRow } from '../../migration/oracle/rows'
import type { RunFrame } from '@/platform/persistence/migration/conversion/lookups/keys'

export function text(row: SourceRow, column: string): string {
  const value = row.values[column]
  if (typeof value !== 'string') throw new Error(`v2-run-source-field:${column}`)
  return value
}
export function nullableText(row: SourceRow, column: string): string | null {
  if (
    row.values[column] === null ||
    (typeof row.values[column] !== 'string' &&
      row.codecTakeovers?.some((failure) => failure.column === column))
  )
    return null
  return text(row, column)
}
export function integer(row: SourceRow, column: string): number {
  const value = row.values[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`v2-run-source-field:${column}`)
  return value
}
export function nullableInteger(row: SourceRow, column: string): number | null {
  return row.values[column] === null ? null : integer(row, column)
}
export function columns(row: SourceRow, names: readonly string[]): Record<string, TargetValue> {
  return Object.fromEntries(
    names.map((name) => {
      if (!Object.hasOwn(row.values, name)) throw new Error(`v2-run-source-field:${name}`)
      return [name, row.values[name]!]
    }),
  )
}
export function oracleRow(row: SourceRow, seq: number, frame: RunFrame): SequencedOracleRunRow {
  return {
    id: text(row, 'id'),
    taskId: text(row, 'task_id'),
    nodeId: text(row, 'node_id'),
    seq,
    status: text(row, 'status') as NodeRunStatus,
    retryIndex: integer(row, 'retry_index'),
    iteration: integer(row, 'iteration'),
    parentNodeRunId: nullableText(row, 'parent_node_run_id'),
    containerRunId: frame.containerRunId,
    shardKey: nullableText(row, 'shard_key'),
    shardValueHash: nullableText(row, 'shard_value_hash'),
    reviewIteration: integer(row, 'review_iteration'),
    wgRound: nullableInteger(row, 'wg_round'),
    rerunCause: nullableText(row, 'rerun_cause'),
    wrapperProgressJson: nullableText(row, 'wrapper_progress_json'),
    consumedUpstreamRunsJson: nullableText(row, 'consumed_upstream_runs_json'),
    childTaskId: nullableText(row, 'child_task_id'),
    startedAt: nullableInteger(row, 'started_at'),
    mergeState: nullableText(row, 'merge_state'),
    supersededByReview: nullableText(row, 'superseded_by_review'),
  }
}
