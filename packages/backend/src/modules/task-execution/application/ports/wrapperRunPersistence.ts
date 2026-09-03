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
    /** RFC-354 — the frame the wrapper node lives in; null at the top scope. */
    readonly containerRunId: string | null
    readonly iteration: number
  }): Promise<ResumableWrapperRunSnapshot | null>
  /**
   * RFC-354 — capture the wrapper's environment: for every external source the
   * body reads (free variables and parameters), the settled row visible in the
   * FRAME the environment chain resolved that source to. The caller walks the
   * chain (it owns the definition); the adapter only picks rows per frame.
   */
  resolveConsumed(input: {
    readonly taskId: string
    readonly sources: ReadonlyArray<{
      readonly nodeId: string
      readonly frame: { readonly containerRunId: string | null; readonly iteration: number }
    }>
  }): Promise<Readonly<Record<string, string>>>
  readStatus(nodeRunId: string): Promise<NodeRunStatus | null>
  clearReuseDisabled(input: {
    readonly nodeRunId: string
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<void>
}
