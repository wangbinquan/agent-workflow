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
  /** 「有 driver 在跑」——运行时一 release 即 false（RFC-359 两阶段停机）。 */
  isActive(taskId: string): boolean
  /**
   * 上一任 driver 已停、库里 owner 行 / intent 还在转移时等它 settle；准入（resume / retry / sync）
   * 放行前先等，否则 continuation intent 会撞上仍是 claimed 的旧 intent（task-continuation-conflict）。
   */
  awaitReleasedSettled(taskId: string): Promise<void>
}

export interface TaskExecutionRuntimeParticipants {
  readonly drive: TaskExecutionDriveParticipant
  readonly children: ChildTaskLifecycleParticipant
  readonly activity: ActiveTaskExecutionParticipant
}
