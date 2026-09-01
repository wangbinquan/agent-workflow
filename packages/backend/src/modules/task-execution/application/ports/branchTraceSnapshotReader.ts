import type { NodeRunStatus } from '@agent-workflow/shared'

export interface BranchTraceRunSnapshot {
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
}
