import type {
  MergeState,
  MergeStateOrNull,
  MergeStateTransitionEvent,
} from '@agent-workflow/shared'

import type { NodeRunMergeWrite } from './nodeRunWrites'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

export type MergeStateProjectionPatch = NodeRunMergeWrite

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
