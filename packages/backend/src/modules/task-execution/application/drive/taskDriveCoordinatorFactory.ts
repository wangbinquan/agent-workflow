// RFC-386: one session owns the mechanics; drive profiles only select per-call differences.
import type { TaskExecutionPersistence } from '../ports/taskExecutionPersistence'
import {
  pickInheritableRunConfig,
  type InheritableRunConfig,
  type SchedulerDriverPort,
  type TaskDriveRuntimeOptions,
  type TaskExecutionTopologyLogger,
} from '../ports/taskExecutionTopology'
import {
  DefaultTaskDriveCoordinator,
  type AdmittedContinuationStep,
  type GateContinuationPreDriveStep,
  type RepositoryPreparationStep,
  type TaskDriveFailureReporter,
  type TaskDriverLifecyclePort,
} from './taskDriveCoordinator'
import { resolveTaskDriveConfig, type TaskDriveCoordinator } from './taskDriveTypes'

export interface TaskDriveFailureProfile {
  readonly errorSummary: string
  readonly failureCode: string
  readonly reason: string
}
export interface TaskDriveProfile {
  readonly runConfig?: { readonly kind: 'inherit-parent'; readonly parent: InheritableRunConfig }
  readonly admittedContinuation?: AdmittedContinuationStep
  readonly failure?: TaskDriveFailureProfile
  readonly engine?: SchedulerDriverPort
}
export interface TaskDriveCoordinatorFactory {
  readonly session: TaskDriveCoordinator
  coordinatorFor(profile: TaskDriveProfile): TaskDriveCoordinator
}
export interface TaskDriveCoordinatorFactoryOptions {
  readonly runConfiguration: () => TaskDriveRuntimeOptions | Promise<TaskDriveRuntimeOptions>
  readonly lifecycle: TaskDriverLifecyclePort
  readonly gateContinuationPreDrive: GateContinuationPreDriveStep
  readonly repositoryPreparation: RepositoryPreparationStep
  readonly engine: () => SchedulerDriverPort
  readonly failures: Pick<TaskExecutionPersistence, 'runtimeLifecycle' | 'intentTerminalization'>
  readonly log: TaskExecutionTopologyLogger
}

const SESSION_FAILURE: TaskDriveFailureProfile = Object.freeze({
  errorSummary: 'task drive failed',
  failureCode: 'task-drive-failed',
  reason: 'task-drive',
})
export const CHILD_LAUNCH_FAILURE: TaskDriveFailureProfile = Object.freeze({
  errorSummary: 'child task launch failed',
  failureCode: 'child-task-launch-failed',
  reason: 'child-launch',
})
export const TASK_RESUME_FAILURE: TaskDriveFailureProfile = Object.freeze({
  errorSummary: 'task resume failed',
  failureCode: 'task-resume-failed',
  reason: 'task-resume',
})

/** Passive composition: configuration and the scheduler back edge are read only after attach. */
export function createTaskDriveCoordinatorFactory(
  options: TaskDriveCoordinatorFactoryOptions,
): TaskDriveCoordinatorFactory {
  async function reportFailure(
    profile: TaskDriveFailureProfile,
    { taskId, error, execution }: Parameters<TaskDriveFailureReporter['report']>[0],
  ) {
    const now = Date.now()
    const errorMessage = error instanceof Error ? error.message : String(error)
    options.log.error(profile.errorSummary, { taskId, error: errorMessage })
    await options.failures.runtimeLifecycle.trySet({
      taskId,
      to: 'failed',
      allowedFrom: ['pending', 'running'],
      extra: { finishedAt: now, errorSummary: profile.errorSummary, errorMessage },
      executionContext: execution,
      now,
      reason: profile.reason,
    })
    await options.failures.intentTerminalization.terminalize({
      taskId,
      state: 'failed',
      failureCode: profile.failureCode,
      now,
      claimedOwnerEpoch: execution.token.epoch,
    })
  }
  function coordinatorFor(profile: TaskDriveProfile): TaskDriveCoordinator {
    return new DefaultTaskDriveCoordinator({
      get runtime() {
        return Promise.resolve().then(async () => {
          const live = await options.runConfiguration()
          return resolveTaskDriveConfig({
            ...live,
            ...(profile.runConfig === undefined
              ? {}
              : pickInheritableRunConfig(profile.runConfig.parent)),
          })
        })
      },
      lifecycle: options.lifecycle,
      admittedContinuation: profile.admittedContinuation,
      gateContinuationPreDrive: options.gateContinuationPreDrive,
      repositoryPreparation: options.repositoryPreparation,
      engineOrchestrator: {
        async drive(context) {
          await (profile.engine ?? options.engine()).drive({
            taskId: context.taskId,
            appHome: context.runtime.appHome,
            ...context.runtime.runtime,
            ...(context.runtime.ensureWorkspaceProfiles ? { ensureWorkspaceProfiles: true } : {}),
            signal: context.signal,
            executionContext: context.execution,
          })
        },
      },
      failureReporter: {
        report: (failure) => reportFailure(profile.failure ?? SESSION_FAILURE, failure),
      },
    })
  }
  return Object.freeze({ session: coordinatorFor({}), coordinatorFor })
}
