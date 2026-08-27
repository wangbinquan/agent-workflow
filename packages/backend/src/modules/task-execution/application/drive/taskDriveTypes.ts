import type { TaskDriveRuntimeKnobs, TaskDriveRuntimeOptions } from '../ports/taskExecutionTopology'

export type TaskDriveCompletionMode = 'background' | 'await-settle'

export interface TaskDriveSubmission {
  readonly taskId: string
  readonly intentId: string
  readonly completionMode: TaskDriveCompletionMode
}

export type TaskDriveReceipt =
  | Readonly<{ kind: 'accepted'; taskId: string }>
  | Readonly<{ kind: 'settled'; taskId: string }>
  | Readonly<{ kind: 'not-attached'; taskId: string }>

export type ResolvedTaskDriveRuntime = Readonly<TaskDriveRuntimeKnobs>

/**
 * Instance-bound runtime profile. Admission commands submit only durable ids;
 * they do not re-spread the daemon configuration into every drive request.
 */
export interface ResolvedTaskDriveConfig {
  readonly appHome: string
  readonly runtime: ResolvedTaskDriveRuntime
  readonly ensureWorkspaceProfiles: boolean
}

export function resolveTaskDriveConfig(options: TaskDriveRuntimeOptions): ResolvedTaskDriveConfig {
  if (options.appHome.length === 0) throw new Error('task drive config requires appHome')
  const { appHome, ensureWorkspaceProfiles, ...runtime } = options
  return Object.freeze({
    appHome,
    runtime: Object.freeze({ ...runtime }),
    ensureWorkspaceProfiles: ensureWorkspaceProfiles === true,
  })
}

export function taskDriveSubmission(input: TaskDriveSubmission): TaskDriveSubmission {
  if (input.taskId.length === 0) throw new Error('task drive submission requires taskId')
  if (input.intentId.length === 0) throw new Error('task drive submission requires intentId')
  return Object.freeze({ ...input })
}

export interface TaskDriveCoordinator {
  submit(input: TaskDriveSubmission): Promise<TaskDriveReceipt>
}
