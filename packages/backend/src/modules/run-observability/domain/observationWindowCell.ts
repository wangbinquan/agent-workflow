import type {
  CompleteObservationTimePartition,
  HistoricalObservationExecution,
} from '@agent-workflow/shared'
import type { CompleteObservationDimension, ObservationTaskFacts } from '@agent-workflow/shared'
import type { CompleteObservationFold } from './completeObservationMetrics'
interface QualifiedObservationDimensionContribution {
  identity: string
  ownerComponent: string
  task: ObservationTaskFacts | null
  cohortAt: number | null
  fold: CompleteObservationFold
  dimension: Pick<CompleteObservationDimension, 'key' | 'kind' | 'label' | 'selection'>
}
/** A reversible numerical bucket, never a substitute for an original record. */
export interface ObservationWindowCell {
  readonly from: number
  readonly to: number
  readonly original: Omit<
    CompleteObservationTimePartition,
    'identity' | 'recordId' | 'metrics' | 'partition' | 'occurrence'
  > & {
    readonly referenceIds: readonly string[]
    readonly model: { provider: string | null; id: string } | null
    readonly candidateCount?: string
    readonly visibility?: readonly { taskId: string | null; ownerUserId: string | null }[]
    readonly scopes?: readonly HistoricalObservationExecution[]
    readonly historicalRecordScopes?: readonly string[]
    readonly nativeRecord?: boolean
    readonly dimensions?: readonly Omit<QualifiedObservationDimensionContribution, 'fold'>[]
  }
}
export function observationWindowCellKey(
  owner: string,
  row: CompleteObservationTimePartition & {
    readonly referenceIds: readonly string[]
    readonly model: { provider: string | null; id: string } | null
    readonly candidateCount?: string
    readonly visibility?: readonly { taskId: string | null; ownerUserId: string | null }[]
    readonly scopes?: readonly HistoricalObservationExecution[]
    readonly historicalRecordScopes?: readonly string[]
    readonly nativeRecord?: boolean
    readonly dimensions?: readonly QualifiedObservationDimensionContribution[]
    readonly unknownDimensions?: readonly QualifiedObservationDimensionContribution[]
  },
): string | null {
  if (row.occurrence.occurredAt === null) return null
  const source = row.historicalRecordScopes?.length
    ? (({ scopes: _scopes, visibility: _visibility, ...original }) => original)(row)
    : row
  const {
    identity: _id,
    recordId: _record,
    metrics: _metrics,
    partition: _partition,
    occurrence: _clock,
    dimensions,
    unknownDimensions: _unknown,
    ...original
  } = source
  const from = Math.floor(row.occurrence.occurredAt / 3600000) * 3600000
  return (
    'occurrence-cell/' +
    JSON.stringify([
      row.task?.id ?? null,
      owner,
      from,
      { ...original, dimensions: dimensions?.map(({ fold: _fold, ...identity }) => identity) },
    ])
  )
}
/** Public occurrence documents retain every original field. Private index
 * metadata is not a second record and must not change the original row oracle. */
export function originalObservationTimePartition(
  row: CompleteObservationTimePartition,
  partition = row.partition,
): CompleteObservationTimePartition {
  return {
    identity: row.identity,
    kind: row.kind,
    recordId: row.recordId,
    sourceId: row.sourceId,
    task: row.task,
    invocation: row.invocation,
    occurrence: row.occurrence,
    metrics: row.metrics,
    partition,
  }
}
export function decodeObservationWindowCell(key: string): ObservationWindowCell {
  if (!key.startsWith('occurrence-cell/')) throw new Error('Invalid occurrence cell')
  const parsed: unknown = JSON.parse(key.slice(16))
  if (!Array.isArray(parsed) || parsed.length !== 4 || !Number.isSafeInteger(parsed[2]))
    throw new Error('Invalid occurrence cell boundary')
  return {
    from: parsed[2] as number,
    to: (parsed[2] as number) + 3600000,
    original: parsed[3] as ObservationWindowCell['original'],
  }
}
export function completeWindowCell(cell: ObservationWindowCell, fold: CompleteObservationFold) {
  return {
    ...cell.original,
    identity: '',
    recordId: '',
    partition: 'in-window' as const,
    occurrence: { occurredAt: cell.from, basis: null },
    metrics: importMetrics(fold),
    projectionCell: { from: cell.from, to: cell.to },
    dimensions: cell.original.dimensions?.map((row) => ({ ...row, fold })),
  }
}
import { completeObservationMetrics as importMetrics } from './completeObservationMetrics'
