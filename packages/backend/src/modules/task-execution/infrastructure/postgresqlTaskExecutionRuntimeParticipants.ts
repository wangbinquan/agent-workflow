import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import { composePostgresqlMemoryInjectionQueries } from '@/modules/memory/composition'
import type { TaskDagCollaborationOperations } from '@/modules/collaboration/public/participants'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { composePostgresqlRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type { DynamicWorkflowValidationContextSource } from '@/services/dynamicWorkflowRunner'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import type {
  TaskExecutionDriveParticipant,
  TaskExecutionRuntimeParticipants,
} from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { WorkgroupTurnsOperations } from '../application/ports/workgroupTurnsOperations'
import { composeExecutionMergeRecovery } from '../composition/executionMergeRecovery'
import { createProviderTaskExecutionModule, type TaskExecutionModule } from '../composition'
import { driveTaskEngineApplication } from '../composition/taskEngineApplication'
import { createPostgresqlTaskExecutionPersistence } from '../composition/taskExecutionPersistence'
import { composeWrapperRuntime } from '../composition/wrapperRuntime'
import { createPostgresqlChildTaskLifecycleParticipant } from './postgresqlChildTaskLifecycleParticipant'
import {
  createPostgresqlChildExecutionLaunchOperations,
  type PostgresqlChildWorkgroupLaunchResources,
} from './postgresqlChildExecutionLaunchOperations'
import { createPostgresqlRuntimeSessionLeaseOperations } from './postgresqlRuntimeSessionLeaseOperations'

/**
 * Cross-context capabilities whose implementations are selected by bootstrap.
 * They are required inputs: PostgreSQL construction never substitutes a
 * SQLite implementation and never silently drops a lifecycle operation.
 */
export interface PostgresqlTaskExecutionRuntimeDependencies {
  readonly taskDagCollaboration: TaskDagCollaborationOperations
  readonly collaborationRuntime: CollaborationRuntimeMechanics
  readonly workgroupTurns: WorkgroupTurnsOperations
  readonly childLaunchWorkgroup: PostgresqlChildWorkgroupLaunchResources
  readonly identityAccess: Readonly<{
    readonly delegatedRequests: DelegatedRequestAuthorityFactory
    readonly taskExecutionResources: TaskExecutionResourceBinding
  }>
  readonly repositoryPublicationTransport: RepositoryPublicationTransport
  /** Bootstrap-selected credential reader; PostgreSQL execution never opens a SQLite fallback. */
  readonly codeHostConnections: CodeHostConnectionsService
  readonly dynamicWorkflow?: Readonly<{
    readonly persistence: DynamicWorkflowPersistence
    readonly validationContext: DynamicWorkflowValidationContextSource
  }>
  /** Daemon-wide identity for process semaphore sharing. */
  readonly processConcurrencyScope: object
  /** Exact process generation persisted in ownership leases. */
  readonly daemonGeneration: string
  /** Source-control selected terminal workspace finalizer. */
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly log: TaskExecutionTopologyLogger
  /** Optional precomposed instances let one bootstrap share exact aggregates. */
  readonly persistence?: TaskExecutionPersistence
  readonly runtimeSessionLeases?: RuntimeSessionLeaseOperations
  /** Share one claim gate and process registry with launch/cancel compositions. */
  readonly executionModule?: TaskExecutionModule
}

export interface PostgresqlTaskExecutionRuntimeAggregate extends TaskExecutionRuntimeParticipants {
  readonly persistence: TaskExecutionPersistence
  readonly executionModule: TaskExecutionModule
}

/**
 * PostgreSQL's final TaskExecution runtime participant factory. All provider
 * clients are captured here; the scheduler and engine receive only closed
 * Promise ports and provider-neutral runtime identities.
 */
export function createPostgresqlTaskExecutionRuntimeParticipants(
  db: PostgresqlDatabaseClient,
  dependencies: PostgresqlTaskExecutionRuntimeDependencies,
): PostgresqlTaskExecutionRuntimeAggregate {
  const persistence = dependencies.persistence ?? createPostgresqlTaskExecutionPersistence(db)
  const executionModule =
    dependencies.executionModule ??
    createProviderTaskExecutionModule({
      daemonGeneration: dependencies.daemonGeneration,
      persistence,
    })
  const runtimeSessionLeases =
    dependencies.runtimeSessionLeases ?? createPostgresqlRuntimeSessionLeaseOperations(db)
  const memoryInjectionQueries = composePostgresqlMemoryInjectionQueries(db)
  const runtimeRegistry = composePostgresqlRuntimeRegistryOperations(db)
  const childLaunch = createPostgresqlChildExecutionLaunchOperations({
    db,
    persistence,
    executionModule,
    finalizeWorkspace: dependencies.finalizeWorkspace,
    log: dependencies.log,
    workgroup: dependencies.childLaunchWorkgroup,
  })
  const runtimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })

  const drive: TaskExecutionDriveParticipant = Object.freeze({
    async drive(
      request: Parameters<TaskExecutionDriveParticipant['drive']>[0],
      topology: Parameters<TaskExecutionDriveParticipant['drive']>[1],
    ) {
      await driveTaskEngineApplication(
        {
          ...request,
          memoryInjectionQueries,
          persistence,
          runtimeSessionLeases,
          runtimeRegistry,
          taskDagCollaboration: dependencies.taskDagCollaboration,
          collaborationRuntime: dependencies.collaborationRuntime,
          workgroupTurns: dependencies.workgroupTurns,
          childLaunch,
          processConcurrencyScope: dependencies.processConcurrencyScope,
          identityAccess: dependencies.identityAccess,
          codeHostConnections: dependencies.codeHostConnections,
          repositoryPublicationTransport: dependencies.repositoryPublicationTransport,
          ...(dependencies.dynamicWorkflow === undefined
            ? {}
            : { dynamicWorkflow: dependencies.dynamicWorkflow }),
        },
        topology,
        runtimeComponents,
      )
    },
  })
  const children = createPostgresqlChildTaskLifecycleParticipant({
    db,
    persistence,
    executionModule,
    runtimeSessionLeases,
    finalizeWorkspace: dependencies.finalizeWorkspace,
    log: dependencies.log,
  })

  return Object.freeze({
    drive,
    children,
    activity: Object.freeze({
      isActive: (taskId: string) => executionModule.runtimeRegistry.hasTask(taskId),
    }),
    persistence,
    executionModule,
  })
}
