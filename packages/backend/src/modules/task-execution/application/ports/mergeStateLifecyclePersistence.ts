import type {
  MergeState,
  MergeStateOrNull,
  MergeStateTransitionEvent,
} from '@agent-workflow/shared'

import type { TaskExecutionContextRef } from './taskExecutionTopology'

export interface MergeStateProjectionPatch {
  readonly isoWorktreePath?: string | null
  readonly isoBaseSnapshot?: string | null
  readonly isoBaseSnapshotReposJson?: string | null
  readonly isoNodeTree?: string | null
  readonly isoNodeTreeReposJson?: string | null
  readonly isoSubmodulesJson?: string | null
  readonly isoSubmodulesReposJson?: string | null
  readonly wrapperProgressJson?: string | null
}

export interface MergeStateLifecyclePersistence {
  transition(input: {
    readonly nodeRunId: string
    readonly event: MergeStateTransitionEvent
    readonly extra?: MergeStateProjectionPatch
    readonly executionContext?: TaskExecutionContextRef
    readonly now?: number
  }): Promise<{ readonly from: MergeStateOrNull; readonly to: MergeState }>
  tryTransition(input: {
    readonly nodeRunId: string
    readonly event: MergeStateTransitionEvent
    readonly extra?: MergeStateProjectionPatch
    readonly executionContext?: TaskExecutionContextRef
    readonly now?: number
  }): Promise<boolean>
}
