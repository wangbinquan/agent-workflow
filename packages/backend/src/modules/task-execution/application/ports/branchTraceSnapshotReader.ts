import type { NodeRunStatus } from '@agent-workflow/shared'
import type { RunHistoryReader } from '../runHistory'

export interface BranchTraceRunSnapshot {
  readonly seq: number
  readonly id: string
  readonly nodeId: string
  readonly status: NodeRunStatus
  readonly iteration: number
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
  readonly errorMessage: string | null
}

export interface BranchTraceOutputSnapshot {
  readonly nodeRunId: string
  readonly portName: string
  readonly content: string
  readonly active: boolean
}

export interface BranchTraceTaskSnapshot {
  readonly workflowSnapshot: string | null
  readonly runs: readonly BranchTraceRunSnapshot[]
  readonly outputs: readonly BranchTraceOutputSnapshot[]
}

export interface BranchTraceSnapshotReader {
  read(taskId: string): Promise<BranchTraceTaskSnapshot | null>
  /** RFC-395 II-a：在已读出的行上取选择历史（选择端口 familyHistory 口径），不另查库。 */
  history(taskId: string, runs: readonly BranchTraceRunSnapshot[]): RunHistoryReader
}
