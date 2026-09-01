import type { NodeRunStatus } from '@agent-workflow/shared'

import type { WrapperRunSnapshot } from '../domain/wrapperExecution'
import { decodeWrapperProgress, encodeWrapperProgress } from '../domain/wrapperProgress'

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

export function wrapperRunSnapshot(row: WrapperRunStorageRow): WrapperRunSnapshot {
  return {
    id: row.id,
    status: row.status,
    wrapperProgressJson: row.wrapperProgressJson,
    consumedUpstreamRunsJson: row.consumedUpstreamRunsJson,
    mergeState: row.mergeState,
    isoBaseSnapshot: row.isoBaseSnapshot,
    isoBaseSnapshotReposJson: row.isoBaseSnapshotReposJson,
    isoSubmodulesJson: row.isoSubmodulesJson,
    isoSubmodulesReposJson: row.isoSubmodulesReposJson,
  }
}

export function clearReuseDisabledProgress(value: string | null): string | null {
  const progress = decodeWrapperProgress(value, () => {})
  if (progress === null || progress.reuseDisabled !== true) return null
  const { reuseDisabled: _cleared, ...rest } = progress
  return encodeWrapperProgress(rest)
}
