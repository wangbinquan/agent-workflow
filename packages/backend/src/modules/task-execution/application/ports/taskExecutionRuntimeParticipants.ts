import type { SchedulerRuntimeTopology } from '../../public/participants'
import type { ChildResumeRuntime, TaskDriveRequest } from './taskExecutionTopology'

/** Provider-selected engine participant captured by bootstrap. */
export interface TaskExecutionDriveParticipant {
  drive(request: TaskDriveRequest, topology: SchedulerRuntimeTopology): Promise<void>
}

/** Provider-selected child lifecycle participant. */
export interface ChildTaskLifecycleParticipant {
  cancel(input: {
    readonly taskId: string
    readonly cause:
      | Readonly<{ readonly kind: 'user' }>
      | Readonly<{ readonly kind: 'parent-cascade'; readonly parentTaskId: string }>
  }): Promise<void>
  resume(
    input: { readonly taskId: string; readonly runtime: ChildResumeRuntime },
    topology: SchedulerRuntimeTopology,
  ): Promise<void>
}

/** Process-local activity is a participant too; the runtime never imports the legacy registry. */
export interface ActiveTaskExecutionParticipant {
  isActive(taskId: string): boolean
}

export interface TaskExecutionRuntimeParticipants {
  readonly drive: TaskExecutionDriveParticipant
  readonly children: ChildTaskLifecycleParticipant
  readonly activity: ActiveTaskExecutionParticipant
}
