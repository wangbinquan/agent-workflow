import type { DbClient } from '@/db/client'
import { cancelTask, isTaskActive, resumeTask } from '@/services/task'
import type { RunTaskOptions } from '@/services/execution/taskEngineRuntimeOptions'
import { humanGateComposition } from '@/services/humanGateComposition'
import type { SchedulerRuntimeTopology } from '../public/participants'
import type { TaskExecutionReadModels } from '../public/types'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import { createSqliteTaskExecutionReadModels } from '../infrastructure/sqliteTaskExecutionReadModels'
import { composeExecutionMergeRecovery } from './executionMergeRecovery'
import { driveTaskEngineApplication } from './taskEngineApplication'
import type { TaskExecutionRuntimeComponents } from './taskExecutionComponents'
import { composeWrapperRuntime } from './wrapperRuntime'

export type TaskRepositoryPublicationTransport = NonNullable<
  RunTaskOptions['repositoryPublicationTransport']
>

export interface TaskExecutionRuntime extends TaskExecutionRuntimeComponents {
  readonly schedulerDriver: SchedulerDriverPort
  readonly topology: SchedulerRuntimeTopology
  readonly readModels: TaskExecutionReadModels
}

export function composeTaskExecutionRuntime(input: {
  readonly db: DbClient
  readonly repositoryPublicationTransport?: TaskRepositoryPublicationTransport
}): TaskExecutionRuntime {
  const { db, repositoryPublicationTransport } = input
  const readModels = createSqliteTaskExecutionReadModels(db)
  const topology = {} as SchedulerRuntimeTopology
  const runtimeComponents: TaskExecutionRuntimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })
  const schedulerDriver: SchedulerDriverPort = {
    async drive(request) {
      await driveTaskEngineApplication(
        {
          ...request,
          db,
          ...(repositoryPublicationTransport === undefined
            ? {}
            : { repositoryPublicationTransport }),
        } as RunTaskOptions,
        topology,
        humanGateComposition.composeTaskExecutionHumanGateAdapter(),
        runtimeComponents,
      )
    },
    async cancelChild(request) {
      await cancelTask(db, request.taskId, { cascadeFromParent: request.cascadeFromParent })
    },
    async resumeChild(request) {
      await resumeTask(db, request.taskId, {
        db,
        schedulerDriver,
        ...(request.runtime.triggerContext === undefined
          ? {}
          : { triggerContext: request.runtime.triggerContext }),
        ...(request.runtime.actorUserId === undefined
          ? {}
          : { actorUserId: request.runtime.actorUserId }),
        ...request.runtime.runConfig,
      })
    },
    isTaskActive,
  }
  Object.assign(topology, {
    schedulerDriver,
  })
  Object.freeze(topology)
  return Object.freeze({ schedulerDriver, topology, readModels, ...runtimeComponents })
}
