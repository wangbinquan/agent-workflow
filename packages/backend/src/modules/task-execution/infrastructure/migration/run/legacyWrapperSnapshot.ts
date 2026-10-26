import type { NodeRunStatus } from '@agent-workflow/shared'

import { decodeTaskCheckpoints } from './legacyCheckpointCodec'
import type { WrapperRunSnapshot } from '../../../domain/wrapperExecution'

export interface WrapperRunStorageRow {
  readonly id: string
  readonly status: NodeRunStatus
  readonly wrapperProgressJson: string | null
  readonly consumedUpstreamRunsJson: string | null
  readonly mergeState: WrapperRunSnapshot['mergeState']
  readonly isoBaseSnapshot: string | null
  readonly isoBaseSnapshotReposJson: string | null
  readonly isoSubmodulesJson: string | null
  readonly isoSubmodulesReposJson: string | null
}

export function wrapperRunSnapshot(
  row: WrapperRunStorageRow,
  mountPaths: readonly string[],
): WrapperRunSnapshot {
  return {
    id: row.id,
    status: row.status,
    wrapperProgressJson: row.wrapperProgressJson,
    consumedUpstreamRunsJson: row.consumedUpstreamRunsJson,
    mergeState: row.mergeState,
    checkpoints: decodeTaskCheckpoints(row, mountPaths),
    hasIsolationBase: row.isoBaseSnapshot !== null || row.isoBaseSnapshotReposJson !== null,
  }
}
