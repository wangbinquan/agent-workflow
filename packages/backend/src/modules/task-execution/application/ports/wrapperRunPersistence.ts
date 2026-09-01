import type { NodeRunStatus } from '@agent-workflow/shared'

import type { WrapperRunSnapshot } from '../../domain/wrapperExecution'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

export interface ResumableWrapperRunSnapshot {
  readonly id: string
  readonly status: NodeRunStatus
  readonly previous: WrapperRunSnapshot
}

export interface WrapperRunPersistence {
  findResumable(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly iteration: number
  }): Promise<ResumableWrapperRunSnapshot | null>
  resolveConsumed(input: {
    readonly taskId: string
    readonly sourceNodeIds: readonly string[]
    readonly iteration: number
  }): Promise<Readonly<Record<string, string>>>
  readStatus(nodeRunId: string): Promise<NodeRunStatus | null>
  clearReuseDisabled(input: {
    readonly nodeRunId: string
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<void>
}
