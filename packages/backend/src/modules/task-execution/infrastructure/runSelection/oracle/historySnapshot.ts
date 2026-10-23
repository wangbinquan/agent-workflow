import type { OracleRunRow } from './rows'
import { createRunSelectionOracleSnapshot, type OracleSnapshotRow } from './snapshot'
import type { OracleSnapshotScope } from './scope'

type RunHistoryProjection = Omit<OracleSnapshotRow, 'status'> & Pick<OracleRunRow, 'status'>

/** Top-level history consumers must load parent identity before filtering. */
export type RunHistoryFacts = RunHistoryProjection & Pick<OracleRunRow, 'parentNodeRunId'>

/** Bind exactly the supplied history and namespace; never fill missing row facts. */
export function createRunHistorySnapshot(
  taskId: string,
  rows: readonly RunHistoryProjection[],
  scope: OracleSnapshotScope = { kind: 'rows' },
) {
  return createRunSelectionOracleSnapshot(
    rows.map((row) => ({ ...row, taskId })),
    { scope },
  )
}
