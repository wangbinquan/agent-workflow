import type { DbClient } from '@/db/client'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import type { MemoryInjectionQueries } from '@/modules/memory/public/queries'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import { cancelTask, isTaskActive, resumeTask } from '@/services/task'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type { TaskExecutionRuntimeParticipants } from '../application/ports/taskExecutionRuntimeParticipants'
import type {
  ChildTaskLifecycleParticipant,
  TaskExecutionDriveParticipant,
} from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import { composeExecutionMergeRecovery } from '../composition/executionMergeRecovery'
import { driveTaskEngineApplication } from '../composition/taskEngineApplication'
import { composeWrapperRuntime } from '../composition/wrapperRuntime'
import type { RuntimeRegistryOperations } from '@/services/runtimeRegistry'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import type { DynamicWorkflowValidationContextSource } from '@/services/dynamicWorkflowRunner'
import { createSqliteTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/sqliteTaskDagCollaborationOperations'
import { createSqliteWorkgroupTurnsOperations } from './sqliteWorkgroupTurnsOperations'
import { createSqliteChildExecutionLaunchOperations } from './sqliteChildExecutionLaunchOperations'

/**
 * SQLite's provider adapter for the closed runtime participants. The database
 * client is captured here once and cannot be forwarded by SchedulerDriverPort.
 */
export function createSqliteTaskExecutionRuntimeParticipants(input: {
  readonly db: DbClient
  readonly memoryInjectionQueries: MemoryInjectionQueries
  readonly collaborationRuntime: CollaborationRuntimeMechanics
  readonly persistence: TaskExecutionPersistence
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  readonly runtimeRegistry: RuntimeRegistryOperations
  readonly dynamicWorkflow?: Readonly<{
    readonly persistence: DynamicWorkflowPersistence
    readonly validationContext: DynamicWorkflowValidationContextSource
  }>
  readonly identityAccess?: Readonly<{
    readonly delegatedRequests: DelegatedRequestAuthorityFactory
    readonly taskExecutionResources: TaskExecutionResourceBinding
  }>
  readonly repositoryPublicationTransport: RepositoryPublicationTransport
}): TaskExecutionRuntimeParticipants {
  const runtimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })

  const drive: TaskExecutionRuntimeParticipants['drive'] = Object.freeze({
    async drive(
      request: Parameters<TaskExecutionDriveParticipant['drive']>[0],
      topology: Parameters<TaskExecutionDriveParticipant['drive']>[1],
    ) {
      await driveTaskEngineApplication(
        {
          ...request,
          memoryInjectionQueries: input.memoryInjectionQueries,
          persistence: input.persistence,
          runtimeSessionLeases: input.runtimeSessionLeases,
          runtimeRegistry: input.runtimeRegistry,
          taskDagCollaboration: createSqliteTaskDagCollaborationOperations(input.db),
          collaborationRuntime: input.collaborationRuntime,
          workgroupTurns: createSqliteWorkgroupTurnsOperations(input.db),
          childLaunch: createSqliteChildExecutionLaunchOperations(input.db),
          ...(input.dynamicWorkflow === undefined
            ? {}
            : { dynamicWorkflow: input.dynamicWorkflow }),
          processConcurrencyScope: input.db,
          ...(input.identityAccess === undefined ? {} : { identityAccess: input.identityAccess }),
          repositoryPublicationTransport: input.repositoryPublicationTransport,
        },
        topology,
        runtimeComponents,
      )
    },
  })
  const children: TaskExecutionRuntimeParticipants['children'] = Object.freeze({
    async cancel(request: Parameters<ChildTaskLifecycleParticipant['cancel']>[0]) {
      await cancelTask(input.db, request.taskId, {
        ...(request.cause.kind === 'parent-cascade'
          ? {
              cascadeFromParent: true,
              cascadeParentTaskId: request.cause.parentTaskId,
            }
          : {}),
      })
    },
    async resume(
      request: Parameters<ChildTaskLifecycleParticipant['resume']>[0],
      topology: Parameters<ChildTaskLifecycleParticipant['resume']>[1],
    ) {
      await resumeTask(input.db, request.taskId, {
        db: input.db,
        taskRecoveryOperations: input.persistence.recoveryAdministration,
        schedulerDriver: topology.schedulerDriver,
        ...(request.runtime.triggerContext === undefined
          ? {}
          : { triggerContext: request.runtime.triggerContext }),
        ...(request.runtime.actorUserId === undefined
          ? {}
          : { actorUserId: request.runtime.actorUserId }),
        ...request.runtime.runConfig,
      })
    },
  })

  return Object.freeze({
    drive,
    children,
    activity: Object.freeze({ isActive: isTaskActive }),
  })
}
