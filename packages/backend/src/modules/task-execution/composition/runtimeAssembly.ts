import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskExecutionRuntimeParticipants } from '../application/ports/taskExecutionRuntimeParticipants'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import type { SchedulerRuntimeTopology } from '../public/participants'
import type { TaskExecutionReadModels } from '../public/types'
import { composeExecutionMergeRecovery } from './executionMergeRecovery'
import type { TaskExecutionRuntimeComponents } from './taskExecutionComponents'
import { composeWrapperRuntime } from './wrapperRuntime'

export type TaskRepositoryPublicationTransport = NonNullable<RepositoryPublicationTransport>

export interface TaskExecutionRuntime extends TaskExecutionRuntimeComponents {
  readonly schedulerDriver: SchedulerDriverPort
  readonly topology: SchedulerRuntimeTopology
  readonly readModels: TaskExecutionReadModels
}

export function composeTaskExecutionRuntime(input: {
  readonly participants: TaskExecutionRuntimeParticipants
  readonly readModels: TaskExecutionReadModels
}): TaskExecutionRuntime {
  const { participants, readModels } = input
  const runtimeComponents: TaskExecutionRuntimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })
  const schedulerDriver: SchedulerDriverPort = {
    async drive(request) {
      await participants.drive.drive(request, topology)
    },
    async cancelChild(request) {
      await participants.children.cancel(request)
    },
    async resumeChild(request) {
      await participants.children.resume(request, topology)
    },
    isTaskActive: (taskId) => participants.activity.isActive(taskId),
  }
  const topology: SchedulerRuntimeTopology = Object.freeze({ schedulerDriver })
  return Object.freeze({
    schedulerDriver,
    topology,
    readModels,
    ...runtimeComponents,
  })
}
