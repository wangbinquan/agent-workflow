import type { DbClient } from '@/db/client'
import type { FusionEngineTaskOperations } from '@/modules/memory/public/fusion'
import {
  createPostgresqlClarifyRepairParticipant,
  createPostgresqlReviewRepairParticipant,
} from '@/modules/collaboration/composition'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import type { TaskExecutionModule } from '../composition'
import { taskExecutionModule } from '../composition'
import type { TaskArchiveMaintenanceCommand } from '../application/ports/taskArchiveMaintenanceCommand'
import type {
  RepositoryPreparationRetryCommand,
  TaskAutoResumeCommand,
} from '../application/ports/taskAutoResumeCommand'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionRuntimeParticipants } from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskLifecycleAutoRepairCommand } from '../application/ports/taskLifecycleAutoRepairCommand'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { TaskExecutionShutdownOperations } from '../application/ports/taskExecutionShutdownOperations'
import type { ChildResumeRuntime } from '../application/ports/taskExecutionTopology'
import type {
  AgentRouteTaskLaunchOperations,
  TaskCancellationCommand,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import type { TaskOverviewQuery } from '../public/queries'
import type { TaskClarifyDirectiveRouteOperations, TaskExecutionReadModels } from '../public/types'
import type { TaskRouteOperations } from '../public/taskRoutes'
import {
  createPostgresqlTaskExecutionRuntimeParticipants,
  type PostgresqlTaskExecutionRuntimeDependencies,
} from '../infrastructure/postgresqlTaskExecutionRuntimeParticipants'
import { createSqliteTaskExecutionRuntimeParticipants } from '../infrastructure/sqliteTaskExecutionRuntimeParticipants'
import { createPostgresqlTaskArchiveMaintenanceCommand } from '../infrastructure/postgresqlTaskArchiveMaintenanceCommand'
import { createSqliteTaskArchiveMaintenanceCommand } from '../infrastructure/sqliteTaskArchiveMaintenanceCommand'
import { createPostgresqlTaskLifecycleAutoRepairCommand } from '../infrastructure/postgresqlTaskLifecycleAutoRepairCommand'
import { createSqliteTaskLifecycleAutoRepairCommand } from '../infrastructure/sqliteTaskLifecycleAutoRepairCommand'
import { createPostgresqlTaskLifecycleWsProjector } from '../infrastructure/postgresqlTaskLifecycleWsProjection'
import { createSqliteTaskLifecycleWsProjector } from '../infrastructure/sqliteTaskLifecycleWsProjection'
import { createPostgresqlTaskOverviewQuery } from '../infrastructure/postgresqlTaskOverviewQuery'
import { createSqliteTaskOverviewQuery } from '../infrastructure/sqliteTaskOverviewQuery'
import { createPostgresqlFusionEngineTaskOperations } from '../infrastructure/postgresqlFusionEngineTaskOperations'
import { createSqliteFusionEngineTaskOperations } from '../infrastructure/fusionEngineTaskOperations'
import {
  createPostgresqlRootTaskLaunchKernel,
  createPostgresqlTaskExecutionLaunchParticipant,
  createPostgresqlTaskRouteLaunchOperations,
  type PostgresqlRootTaskLaunchKernel,
  type PostgresqlTaskRouteLaunchDependencies,
} from '../infrastructure/postgresqlTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteWorkspaceParticipant,
  createPostgresqlTaskWorkspaceMaterializer,
  type PostgresqlTaskRouteWorkspaceDependencies,
} from '../infrastructure/postgresqlTaskRouteWorkspaceParticipant'
import { createPostgresqlRepositoryPreparationRetryCommand } from '../infrastructure/postgresqlRepositoryPreparationRetryCommand'
import {
  createSqliteTaskRouteLaunchOperations,
  type SqliteTaskRouteLaunchDependencies,
} from '../infrastructure/sqliteTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteOperations,
  type PostgresqlTaskRouteOperationsDependencies,
} from '../infrastructure/postgresqlTaskRouteOperations'
import {
  createSqliteTaskRouteOperations,
  type SqliteTaskRouteOperationsDependencies,
} from '../infrastructure/sqliteTaskRouteOperations'
import { composeTaskExecutionRuntime, type TaskExecutionRuntime } from './runtimeAssembly'
import { composeTaskAutoResumeCommand } from './taskAutoResume'
import { composeTaskClarifyDirectiveRouteOperations } from './taskClarifyDirectiveRoutes'
import { createSqliteTaskExecutionPersistence } from './taskExecutionPersistence'
import {
  createBuildScheduleLaunch,
  createPostgresqlTaskExecutionTriggerParticipant,
  createSqliteTaskExecutionTriggerParticipant,
  type TaskExecutionTriggerParticipant,
} from './triggerExecution'
import {
  composePostgresqlWorkgroupTaskRoomTaskParticipantFactory,
  type PostgresqlWorkgroupTaskRoomClarifyParticipantFactory,
  type PostgresqlWorkgroupTaskRoomTaskParticipantFactory,
} from './workgroupTaskRoomTask'
import {
  composeTaskExecutionProviderBackground,
  type TaskExecutionProviderBackgroundControl,
  type TaskExecutionProviderBackgroundStartDependencies,
} from './providerBackground'

export type TaskExecutionBackgroundControl = TaskExecutionProviderBackgroundControl
export type TaskExecutionBackgroundStartDependencies =
  TaskExecutionProviderBackgroundStartDependencies

interface SelectedTaskExecutionProviderRuntimeBase {
  readonly participants: TaskExecutionRuntimeParticipants
  readonly persistence: TaskExecutionPersistence
  readonly runtime: TaskExecutionRuntime
  readonly executionModule: TaskExecutionModule
  readonly readModels: TaskExecutionReadModels
  readonly recovery: TaskRecoveryOperations
  readonly shutdown: TaskExecutionShutdownOperations
  readonly archive: TaskArchiveMaintenanceCommand
  readonly autoResume: TaskAutoResumeCommand
  readonly repositoryPreparationRetry: RepositoryPreparationRetryCommand
  readonly lifecycleRepair: TaskLifecycleAutoRepairCommand
  readonly lifecycleProjector: CommittedEventConsumerDefinition
  readonly overview: TaskOverviewQuery
  readonly fusion: FusionEngineTaskOperations
  readonly cancellation: TaskCancellationCommand
  readonly trigger: Readonly<{
    readonly taskExecutions: TaskExecutionTriggerParticipant
    readonly buildScheduleLaunch: BuildScheduleLaunch
  }>
  readonly routeLaunch: Readonly<{
    agent: AgentRouteTaskLaunchOperations
    workgroup: WorkgroupRouteTaskLaunchOperations
    /** Workflow route performs its own workflow/OCC checks before this kernel. */
    workflow?: PostgresqlRootTaskLaunchKernel
  }>
  readonly routes: Readonly<{
    readonly tasks: TaskRouteOperations
    readonly clarifyDirective: TaskClarifyDirectiveRouteOperations
  }>
  readonly background: TaskExecutionBackgroundControl
}

export interface SelectedSqliteTaskExecutionProviderRuntime extends SelectedTaskExecutionProviderRuntimeBase {
  readonly provider: 'sqlite'
}

export interface SelectedPostgresqlTaskExecutionProviderRuntime extends SelectedTaskExecutionProviderRuntimeBase {
  readonly provider: 'postgresql'
  /**
   * TaskExecution's half of the Workgroup room transaction. Resource Catalog
   * reserves the transaction and binds this factory together with Workflow;
   * Collaboration receives the exact same reserved transaction.
   */
  readonly workgroupTaskRoom: PostgresqlWorkgroupTaskRoomTaskParticipantFactory
}

export type SelectedTaskExecutionProviderRuntime =
  | SelectedSqliteTaskExecutionProviderRuntime
  | SelectedPostgresqlTaskExecutionProviderRuntime

/** Late route composition breaks the Collaboration↔TaskExecution read-model cycle. */
export interface TaskExecutionProviderRouteContext {
  readonly readModels: TaskExecutionReadModels
  readonly recovery: TaskRecoveryOperations
}

function cancellationCommand(
  participants: TaskExecutionRuntimeParticipants,
): TaskCancellationCommand {
  return Object.freeze({
    async cancel(input: Parameters<TaskCancellationCommand['cancel']>[0]) {
      await participants.children.cancel(input)
    },
  })
}

export interface SqliteTaskExecutionProviderRuntimeDependencies {
  readonly runtime: Omit<
    Parameters<typeof createSqliteTaskExecutionRuntimeParticipants>[0],
    'db' | 'persistence' | 'codeHostConnections'
  > &
    Required<
      Pick<
        Parameters<typeof createSqliteTaskExecutionRuntimeParticipants>[0],
        'codeHostConnections'
      >
    >
  readonly routeLaunch: Omit<SqliteTaskRouteLaunchDependencies, 'db'>
  readonly routes: (
    context: TaskExecutionProviderRouteContext,
  ) => Omit<SqliteTaskRouteOperationsDependencies, 'db' | 'recovery'>
  readonly lifecycleRepair: Omit<
    Parameters<typeof createSqliteTaskLifecycleAutoRepairCommand>[0],
    'db' | 'operations'
  >
  readonly fusion: Omit<
    Parameters<typeof createSqliteFusionEngineTaskOperations>[0],
    'db' | 'schedulerDriver'
  >
  readonly trigger: Readonly<{
    readonly executionFor: Parameters<
      typeof createSqliteTaskExecutionTriggerParticipant
    >[0]['executionFor']
  }>
  readonly rootResumeRuntime: (taskId: string) => ChildResumeRuntime
  readonly repositoryPreparationRetry: RepositoryPreparationRetryCommand
}

/** Complete SQLite binding retained for direct tests and legacy bootstrap. */
export function composeSqliteTaskExecutionProviderRuntime(
  db: DbClient,
  dependencies: SqliteTaskExecutionProviderRuntimeDependencies,
): SelectedSqliteTaskExecutionProviderRuntime {
  const persistence = createSqliteTaskExecutionPersistence(db)
  const participants = createSqliteTaskExecutionRuntimeParticipants({
    db,
    persistence,
    ...dependencies.runtime,
  })
  const runtime = composeTaskExecutionRuntime({ participants, readModels: persistence.reads })
  const routeLaunch = createSqliteTaskRouteLaunchOperations({
    db,
    ...dependencies.routeLaunch,
  })
  const routeDependencies = dependencies.routes({
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
  })
  const taskRoutes = createSqliteTaskRouteOperations({
    db,
    recovery: persistence.recoveryAdministration,
    ...routeDependencies,
  })
  const cancellation = cancellationCommand(participants)
  const taskExecutions = createSqliteTaskExecutionTriggerParticipant({
    db,
    cancellation,
    executionFor: dependencies.trigger.executionFor,
  })
  const resume = Object.freeze({
    async resume(taskId: string) {
      await participants.children.resume(
        { taskId, runtime: dependencies.rootResumeRuntime(taskId) },
        runtime.topology,
      )
    },
  })
  const autoResume = composeTaskAutoResumeCommand({
    recovery: persistence.recoveryAdministration,
    resume,
    repositoryPreparation: dependencies.repositoryPreparationRetry,
  })
  const lifecycleRepair = createSqliteTaskLifecycleAutoRepairCommand({
    db,
    operations: persistence.recoveryAdministration,
    ...dependencies.lifecycleRepair,
  })
  const buildScheduleLaunch = createBuildScheduleLaunch(taskExecutions)
  const background = composeTaskExecutionProviderBackground({
    module: taskExecutionModule,
    lifecycleRepair,
    autoResume,
    recovery: persistence.recoveryAdministration,
    taskHasDriver: runtime.schedulerDriver.isTaskActive,
    buildScheduleLaunch,
  })
  return Object.freeze({
    provider: 'sqlite',
    participants,
    persistence,
    runtime,
    executionModule: taskExecutionModule,
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
    shutdown: persistence.shutdown,
    archive: createSqliteTaskArchiveMaintenanceCommand(db),
    autoResume,
    repositoryPreparationRetry: dependencies.repositoryPreparationRetry,
    lifecycleRepair,
    lifecycleProjector: createSqliteTaskLifecycleWsProjector(db),
    overview: createSqliteTaskOverviewQuery(db),
    fusion: createSqliteFusionEngineTaskOperations({
      db,
      schedulerDriver: runtime.schedulerDriver,
      ...dependencies.fusion,
    }),
    cancellation,
    trigger: Object.freeze({
      taskExecutions,
      buildScheduleLaunch,
    }),
    routeLaunch: Object.freeze({ ...routeLaunch }),
    routes: Object.freeze({
      tasks: taskRoutes,
      clarifyDirective: composeTaskClarifyDirectiveRouteOperations(routeDependencies.collaboration),
    }),
    background,
  })
}

export interface PostgresqlTaskExecutionProviderRuntimeDependencies {
  readonly runtime: Omit<PostgresqlTaskExecutionRuntimeDependencies, 'childLaunchWorkgroup'>
  readonly rootResumeRuntime: (taskId: string) => ChildResumeRuntime
  readonly routeLaunch: Omit<PostgresqlTaskRouteLaunchDependencies, 'db' | 'workspace'>
  readonly routeWorkspace: Omit<PostgresqlTaskRouteWorkspaceDependencies, 'db'>
  readonly routes: (
    context: TaskExecutionProviderRouteContext,
  ) => Omit<
    PostgresqlTaskRouteOperationsDependencies,
    | 'db'
    | 'persistence'
    | 'children'
    | 'activity'
    | 'topology'
    | 'resumeRuntimeFor'
    | 'repositoryPreparationRetry'
    | 'launch'
    | 'repair'
  >
  readonly lifecycleRepair: Omit<
    Parameters<typeof createPostgresqlTaskLifecycleAutoRepairCommand>[0],
    'db' | 'operations' | 'lifecycle' | 'activity' | 'resume'
  >
  readonly fusion: Readonly<{ appHome: string }>
  readonly workgroupTaskRoom: Readonly<{
    readonly collaboration: PostgresqlWorkgroupTaskRoomClarifyParticipantFactory
  }>
}

/**
 * Final PostgreSQL TaskExecution composition. Every runtime, maintenance,
 * projection, overview, fusion and route-launch operation captures the same
 * provider client and the same process execution module.
 */
export function composePostgresqlTaskExecutionProviderRuntime(
  db: PostgresqlDatabaseClient,
  dependencies: PostgresqlTaskExecutionProviderRuntimeDependencies,
): SelectedPostgresqlTaskExecutionProviderRuntime {
  const participants = createPostgresqlTaskExecutionRuntimeParticipants(db, {
    ...dependencies.runtime,
    childLaunchWorkgroup: dependencies.routeLaunch.workgroup,
  })
  const persistence = participants.persistence
  const runtime = composeTaskExecutionRuntime({ participants, readModels: persistence.reads })
  const workspaceDependencies: PostgresqlTaskRouteWorkspaceDependencies = {
    db,
    ...dependencies.routeWorkspace,
  }
  const routeWorkspace = createPostgresqlTaskRouteWorkspaceParticipant(workspaceDependencies)
  const taskRouteLaunchDependencies: Omit<PostgresqlTaskRouteLaunchDependencies, 'db'> = {
    workspace: routeWorkspace,
    ...dependencies.routeLaunch,
  }
  const routeLaunchDependencies: PostgresqlTaskRouteLaunchDependencies = {
    db,
    ...taskRouteLaunchDependencies,
  }
  const routeLaunch = createPostgresqlTaskRouteLaunchOperations(routeLaunchDependencies)
  const repositoryPreparationRetry = createPostgresqlRepositoryPreparationRetryCommand({
    db,
    appHome: dependencies.routeWorkspace.appHome,
    workspace: createPostgresqlTaskWorkspaceMaterializer(workspaceDependencies),
    coordinator: dependencies.routeLaunch.coordinator,
    isTaskActive: participants.activity.isActive,
    log: dependencies.runtime.log,
  })
  const routeDependencies = dependencies.routes({
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
  })
  const taskRoutes = createPostgresqlTaskRouteOperations({
    db,
    persistence,
    children: participants.children,
    activity: participants.activity,
    topology: runtime.topology,
    resumeRuntimeFor: (_actor, taskId) => dependencies.rootResumeRuntime(taskId),
    repositoryPreparationRetry,
    launch: taskRouteLaunchDependencies,
    repair: {
      collaborationRuntime: dependencies.runtime.collaborationRuntime,
      clarify: createPostgresqlClarifyRepairParticipant(db),
      review: createPostgresqlReviewRepairParticipant(db),
    },
    ...routeDependencies,
  })
  const cancellation = cancellationCommand(participants)
  const taskExecutions = createPostgresqlTaskExecutionTriggerParticipant({
    launches: createPostgresqlTaskExecutionLaunchParticipant(routeLaunchDependencies),
    cancellation,
  })
  const resume = Object.freeze({
    async resume(taskId: string) {
      await participants.children.resume(
        { taskId, runtime: dependencies.rootResumeRuntime(taskId) },
        runtime.topology,
      )
    },
  })
  const autoResume = composeTaskAutoResumeCommand({
    recovery: persistence.recoveryAdministration,
    resume,
    repositoryPreparation: repositoryPreparationRetry,
  })
  const lifecycleRepair = createPostgresqlTaskLifecycleAutoRepairCommand({
    db,
    operations: persistence.recoveryAdministration,
    lifecycle: persistence.runtimeLifecycle,
    activity: participants.activity,
    resume,
    ...dependencies.lifecycleRepair,
  })
  const buildScheduleLaunch = createBuildScheduleLaunch(taskExecutions)
  const background = composeTaskExecutionProviderBackground({
    module: participants.executionModule,
    lifecycleRepair,
    autoResume,
    recovery: persistence.recoveryAdministration,
    taskHasDriver: runtime.schedulerDriver.isTaskActive,
    buildScheduleLaunch,
  })
  return Object.freeze({
    provider: 'postgresql',
    participants,
    persistence,
    runtime,
    executionModule: participants.executionModule,
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
    shutdown: persistence.shutdown,
    archive: createPostgresqlTaskArchiveMaintenanceCommand(db),
    autoResume,
    repositoryPreparationRetry,
    lifecycleRepair,
    lifecycleProjector: createPostgresqlTaskLifecycleWsProjector(db),
    overview: createPostgresqlTaskOverviewQuery(db),
    fusion: createPostgresqlFusionEngineTaskOperations({
      db,
      appHome: dependencies.fusion.appHome,
      schedulerDriver: runtime.schedulerDriver,
      persistence,
      executionModule: participants.executionModule,
      finalizeWorkspace: dependencies.runtime.finalizeWorkspace,
      log: dependencies.runtime.log,
    }),
    cancellation,
    trigger: Object.freeze({
      taskExecutions,
      buildScheduleLaunch,
    }),
    routeLaunch: Object.freeze({
      ...routeLaunch,
      workflow: createPostgresqlRootTaskLaunchKernel(routeLaunchDependencies),
    }),
    routes: Object.freeze({
      tasks: taskRoutes,
      clarifyDirective: composeTaskClarifyDirectiveRouteOperations(routeDependencies.collaboration),
    }),
    workgroupTaskRoom: composePostgresqlWorkgroupTaskRoomTaskParticipantFactory({
      collaboration: dependencies.workgroupTaskRoom.collaboration,
    }),
    background,
  })
}
