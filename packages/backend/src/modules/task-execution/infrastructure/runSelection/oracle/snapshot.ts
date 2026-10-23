import type { RunSelectionReader } from '../../../application/ports/runSelection'
import { decodeConsumedEdges } from './consumed'
import {
  oracleCurrent,
  oracleCurrentInFrame,
  oracleFamilyRows,
  oracleHistory,
  oracleSlotRows,
} from './pickers'
import { oracleRunRef, oracleSelectedRun, type OracleRunRow } from './rows'
import { oracleShardSet } from './shards'
import { bindOracleRow, bindOracleSnapshotScope, type OracleSnapshotScope } from './scope'

/** A projected row is legal only with an explicit comparison scope. */
export interface OracleSnapshotRow extends Pick<OracleRunRow, 'id' | 'nodeId' | 'seq'> {
  readonly status: string
  readonly taskId?: OracleRunRow['taskId']
  readonly retryIndex?: OracleRunRow['retryIndex']
  readonly iteration?: OracleRunRow['iteration']
  readonly parentNodeRunId?: OracleRunRow['parentNodeRunId']
  readonly containerRunId?: OracleRunRow['containerRunId']
  readonly shardKey?: OracleRunRow['shardKey']
  readonly shardValueHash?: OracleRunRow['shardValueHash']
  readonly reviewIteration?: OracleRunRow['reviewIteration']
  readonly wgRound?: OracleRunRow['wgRound']
  readonly rerunCause?: OracleRunRow['rerunCause']
  readonly wrapperProgressJson?: OracleRunRow['wrapperProgressJson']
  readonly consumedUpstreamRunsJson?: OracleRunRow['consumedUpstreamRunsJson']
  readonly childTaskId?: OracleRunRow['childTaskId']
  readonly startedAt?: OracleRunRow['startedAt']
  readonly mergeState?: OracleRunRow['mergeState']
  readonly supersededByReview?: OracleRunRow['supersededByReview']
}

export function createRunSelectionOracleSnapshot(input: readonly OracleRunRow[]): RunSelectionReader
export function createRunSelectionOracleSnapshot(
  input: readonly OracleSnapshotRow[],
  options: { readonly scope: OracleSnapshotScope },
): RunSelectionReader
/** Full task snapshots validate all columns eagerly. Scoped projections fail on missing access. */
export function createRunSelectionOracleSnapshot(
  input: readonly OracleSnapshotRow[],
  options?: { readonly scope: OracleSnapshotScope },
): RunSelectionReader {
  const scope = options?.scope ?? { kind: 'task' }
  const snapshot = input.map((row) =>
    bindOracleRow(row as Partial<OracleRunRow>, options === undefined),
  )
  const byTask = new Map<string, OracleRunRow[]>()
  let unboundTask = false
  for (const [index, row] of snapshot.entries()) {
    if (input[index]!.taskId === undefined) {
      unboundTask = true
      continue
    }
    const rows = byTask.get(row.taskId) ?? []
    rows.push(row)
    byTask.set(row.taskId, rows)
  }
  const byId = new Map(snapshot.map((row) => [row.id, row]))
  for (const rows of byTask.values()) bindOracleSnapshotScope(rows, scope)
  const taskRows = (taskId: string): readonly OracleRunRow[] => {
    if (unboundTask) throw new Error('oracle-snapshot-field-missing:taskId')
    const existing = byTask.get(taskId)
    if (existing !== undefined) return existing
    const empty: OracleRunRow[] = []
    bindOracleSnapshotScope(empty, scope)
    byTask.set(taskId, empty)
    return empty
  }
  return {
    async current(taskId, slot) {
      const rows = taskRows(taskId)
      const row = oracleCurrent(rows, slot)
      return row === undefined ? null : oracleSelectedRun(row, rows, slot)
    },
    async currentInFrame(taskId, frame) {
      const rows = taskRows(taskId)
      return new Map(
        [...oracleCurrentInFrame(rows, frame)].map(([nodeId, row]) => [
          nodeId,
          oracleSelectedRun(row, rows),
        ]),
      )
    },
    async shardSet(taskId, wrapper) {
      return oracleShardSet(taskRows(taskId), wrapper)
    },
    async slotHistory(taskId, slot, filter) {
      const rows = taskRows(taskId)
      return oracleHistory(oracleSlotRows(rows, slot), rows, filter).map((row) =>
        oracleRunRef(row, rows, slot),
      )
    },
    async familyHistory(taskId, family, filter) {
      const rows = taskRows(taskId)
      return oracleHistory(oracleFamilyRows(rows, family), rows, filter).map((row) =>
        oracleRunRef(row, rows),
      )
    },
    async consumed(runId) {
      return decodeConsumedEdges(byId.get(runId)?.consumedUpstreamRunsJson)
    },
  }
}
