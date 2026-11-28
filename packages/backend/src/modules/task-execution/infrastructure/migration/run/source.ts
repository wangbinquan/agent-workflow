import type { NodeRunStatus } from '@agent-workflow/shared'
import type {
  ConversionBlock,
  SourceRow,
  TargetValue,
} from '@/platform/persistence/migration/conversion/types'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { SequencedOracleRunRow } from '../../migration/oracle/rows'
import type { RunFrame } from '@/platform/persistence/migration/conversion/lookups/keys'

/**
 * RFC-626: the columns of a run row the converter reads as numbers. An integer past 2^53
 * decodes to a bigint, which no number column can carry; such a row used to throw while the
 * lookups were built and abort the whole conversion. The lookups now skip it and the rules set
 * it aside with `v2-run-row-unusable`. Both use `unusableNumberColumns`, so they always agree.
 */
export interface RunNumberColumn {
  readonly name: string
  readonly nullable: boolean
}
export const RUN_NUMBER_COLUMNS: readonly RunNumberColumn[] = [
  { name: 'seq', nullable: true },
  { name: 'iteration', nullable: false },
  { name: 'retry_index', nullable: false },
  { name: 'review_iteration', nullable: false },
  { name: 'wg_round', nullable: true },
  { name: 'started_at', nullable: true },
]
export const ALLOCATION_NUMBER_COLUMNS: readonly RunNumberColumn[] = [
  { name: 'seq', nullable: false },
]
export const RUN_ROW_UNUSABLE = 'v2-run-row-unusable'
/** The listed columns whose value is not a safe integer (or NULL where NULL is allowed). */
export function unusableNumberColumns(
  row: SourceRow,
  columns: readonly RunNumberColumn[] = RUN_NUMBER_COLUMNS,
): readonly string[] {
  return columns
    .filter(({ name, nullable }) => {
      const value = row.values[name]
      return value === null ? !nullable : typeof value !== 'number' || !Number.isSafeInteger(value)
    })
    .map(({ name }) => name)
}
/** A run row the run lookups read: decoded, with every number column usable. */
export function readableRun(row: SourceRow): boolean {
  return !row.codecFailure && unusableNumberColumns(row).length === 0
}
export function unusableRowBlock(row: SourceRow, columns: readonly string[]): ConversionBlock {
  return rowBlock(
    RUN_ROW_UNUSABLE,
    row,
    {
      unusable: columns.map((column) => {
        const value = row.values[column]
        return { column, value: value === null || value === undefined ? null : String(value) }
      }),
    },
    columns,
  )
}

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
