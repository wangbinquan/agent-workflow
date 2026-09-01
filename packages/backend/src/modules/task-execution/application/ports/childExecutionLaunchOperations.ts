import type { Actor } from '@/auth/actor'
import type { FrozenWorkgroupRef } from '@/services/execution/closure'
import type { MaterializedSpace } from '@/services/task'
import type { StartTask } from '@agent-workflow/shared'
import type { ChildResumeRuntime, SchedulerDriverPort } from './taskExecutionTopology'

interface ChildLaunchContext {
  readonly actor: Actor
  readonly parentTaskId: string
  readonly parentNodeRunId: string
  readonly invocationDepth: number
  readonly materializedSpace: MaterializedSpace
  readonly runtime: ChildResumeRuntime
  readonly schedulerDriver: Pick<SchedulerDriverPort, 'drive'>
}

export interface ChildWorkflowLaunchRequest extends ChildLaunchContext {
  readonly workflowId: string
  readonly frozenWorkflowVersion: number
  readonly payload: StartTask
  readonly frozenSnapshotJson: string
  readonly refClosureJson: string | null
}

export interface ChildWorkgroupLaunchRequest extends ChildLaunchContext {
  readonly frozenGroup: FrozenWorkgroupRef
  readonly goal: string
  readonly name: string
  readonly collaboratorUserIds: readonly string[]
  readonly maxDurationMs?: number
  readonly maxTotalTokens?: number
}

/** Provider-selected child creation boundary used by call nodes. */
export interface ChildExecutionLaunchOperations {
  launchWorkflow(request: ChildWorkflowLaunchRequest): Promise<void>
  launchWorkgroup(request: ChildWorkgroupLaunchRequest): Promise<void>
}
