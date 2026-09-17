import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { FusionEngineTaskOperations } from '@/modules/knowledge-evolution/public/participants'
import {
  createPostgresqlClarifyRepairParticipant,
  createPostgresqlReviewRepairParticipant,
} from '@/modules/collaboration/composition'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import type { ProviderTaskExecutionModule, TaskExecutionModule } from '../composition'
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
import { createDrizzleTaskArchiveMaintenanceCommand } from '../infrastructure/taskArchiveMaintenanceCommand'
import type { AutomaticTaskRepairOptions } from '../infrastructure/postgresqlTaskRouteRepairOperations'
import { createTaskLifecycleAutoRepairCommand } from './taskLifecycleRepair'
import { createDatabaseTaskLifecycleWsProjector } from '../infrastructure/taskLifecycleWsProjection'
import { createTaskOverviewQuery } from '../infrastructure/taskOverviewQuery'
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
  createSqliteTaskExecutionLaunchParticipant,
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
import { createTaskExecutionPersistence } from './taskExecutionPersistence'
import {
  createBuildScheduleLaunch,
  createTaskExecutionTriggerParticipant,
  type TaskExecutionTriggerParticipant,
} from './triggerExecution'
import {
  composeWorkgroupTaskRoomTaskParticipantFactory,
  type WorkgroupTaskRoomClarifyParticipantFactory,
  type WorkgroupTaskRoomTaskParticipantFactory,
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

type SqliteRouteCollaborationContext = SqliteTaskRouteOperationsDependencies['collaboration']

export interface SelectedSqliteTaskExecutionProviderRuntime<
  C extends SqliteRouteCollaborationContext = SqliteRouteCollaborationContext,
> extends SelectedTaskExecutionProviderRuntimeBase {
  readonly provider: 'sqlite'
  /** The route context constructed in this same provider graph. */
  readonly collaboration: C
}

export interface SelectedPostgresqlTaskExecutionProviderRuntime extends SelectedTaskExecutionProviderRuntimeBase {
  readonly provider: 'postgresql'
  readonly routeLaunch: SelectedTaskExecutionProviderRuntimeBase['routeLaunch'] & {
    readonly workflow: PostgresqlRootTaskLaunchKernel
  }
  /**
   * RFC-359 W5-T19b —— PG 这一支的模块**必定**已经拿到持久化：它由
   * `createPostgresqlTaskExecutionRuntimeParticipants` 用 `createProviderTaskExecutionModule`
   * 造出来。把这件事写进类型，`postgresqlTaskDriverLifecycle` 要的 `claimPersisted` 就在
   * 装配处得到保证；SQLite 那一支用的是进程级单例（没有持久化、走同步 `claim(db)`），
   * 所以基类那格仍是 `TaskExecutionModule`，两支不共用一个「可能没装配」的槽。
   */
  readonly executionModule: ProviderTaskExecutionModule
  /**
   * TaskExecution's half of the Workgroup room transaction. Resource Catalog
   * reserves the transaction and binds this factory together with Workflow;
   * Collaboration receives the exact same reserved transaction.
   */
  readonly workgroupTaskRoom: WorkgroupTaskRoomTaskParticipantFactory
}

export type SelectedTaskExecutionProviderRuntime<
  C extends SqliteRouteCollaborationContext = SqliteRouteCollaborationContext,
> = SelectedSqliteTaskExecutionProviderRuntime<C> | SelectedPostgresqlTaskExecutionProviderRuntime

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

export interface SqliteTaskExecutionProviderRuntimeDependencies<
  C extends SqliteRouteCollaborationContext = SqliteRouteCollaborationContext,
> {
  readonly runtime: Omit<
    Parameters<typeof createSqliteTaskExecutionRuntimeParticipants>[0],
    // RFC-359 AC-1（plan §5hn 批次二 ⑤）：`childLaunchWorkgroup` 与 PostgreSQL 那一支同形——
    // 由本组合根从 `routeLaunch.workgroup` 取，装配方不必交第二份。
    'db' | 'persistence' | 'codeHostConnections' | 'childLaunchWorkgroup'
  > &
    Required<
      Pick<
        Parameters<typeof createSqliteTaskExecutionRuntimeParticipants>[0],
        'codeHostConnections'
      >
    >
  readonly routeLaunch: Omit<SqliteTaskRouteLaunchDependencies, 'db'>
  readonly routes: (context: TaskExecutionProviderRouteContext) => Omit<
    SqliteTaskRouteOperationsDependencies,
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：`activity` 与 `recovery` / `launches` 同档
    // ——它是**运行时装配出来的参与者**，由本函数直接交给路由，不劳调用方的 routes 回调再拼一遍。
    // 第 8 刀把共用修复实现的依赖面（`persistence` / `children` / `topology` /
    // `resumeRuntimeFor` / `repair`）一并归到这一档：它们同样是本函数手里现成的装配产物。
    | 'db'
    | 'recovery'
    | 'collaboration'
    | 'launches'
    | 'activity'
    | 'persistence'
    | 'resumeTaskAs'
    | 'repair'
  > & {
    readonly collaboration: C
  }
  readonly lifecycleRepair: Omit<AutomaticTaskRepairOptions, 'resume'>
  readonly fusion: Omit<
    Parameters<typeof createSqliteFusionEngineTaskOperations>[0],
    'db' | 'schedulerDriver'
  >
  readonly rootResumeRuntime: (taskId: string) => ChildResumeRuntime
  readonly repositoryPreparationRetry: RepositoryPreparationRetryCommand
}

/** Complete SQLite binding retained for direct tests and legacy bootstrap. */
export function composeSqliteTaskExecutionProviderRuntime<
  C extends SqliteRouteCollaborationContext,
>(
  db: DbClient,
  dependencies: SqliteTaskExecutionProviderRuntimeDependencies<C>,
): SelectedSqliteTaskExecutionProviderRuntime<C> {
  const persistence = createTaskExecutionPersistence(db)
  const participants = createSqliteTaskExecutionRuntimeParticipants({
    db,
    persistence,
    ...dependencies.runtime,
    childLaunchWorkgroup: dependencies.routeLaunch.workgroup,
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
  // RFC-359 AC-1（plan §5hn 批次二 ④）：工作流 JSON 启动的编排与 PostgreSQL 共用同一份。
  // 装配一次，路由与触发器两处都用它。`startExecution` 在生产上还剩两条调用路：
  // 子任务（`sqliteChildExecutionLaunchOperations`）与 multipart（`services/multipartTaskStart`），
  // 各自单独一刀。
  const launches = createSqliteTaskExecutionLaunchParticipant({ db, ...dependencies.routeLaunch })
  const taskRoutes = createSqliteTaskRouteOperations({
    db,
    recovery: persistence.recoveryAdministration,
    launches,
    activity: participants.activity,
    // RFC-359 AC-1（第 8 刀）：手动 + 自动修复都走共用的那一份实现，依赖面由这里注入。
    persistence,
    resumeTaskAs: async (_actor, taskId) => {
      await participants.children.resume(
        { taskId, runtime: dependencies.rootResumeRuntime(taskId) },
        runtime.topology,
      )
    },
    repair: {
      collaborationRuntime: dependencies.runtime.collaborationRuntime,
      clarify: createPostgresqlClarifyRepairParticipant(db),
      review: createPostgresqlReviewRepairParticipant(db),
    },
    ...routeDependencies,
  })
  const cancellation = cancellationCommand(participants)
  // RFC-359 AC-1（plan §5hn 批次二 ①②）：触发器参与者两个引擎共用一份。
  // 此前 SQLite 那半自己调 `startExecution`（那是启动参与者的第二份写法），
  // PG 那半只是八行转发；SQLite 一有启动参与者，这一对就塌成一份。
  const taskExecutions = createTaskExecutionTriggerParticipant({ launches, cancellation })
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
  // RFC-359 AC-1（第 8 刀）：自动修复循环与 PostgreSQL 共用**同一个**绑定。
  const lifecycleRepair = createTaskLifecycleAutoRepairCommand({
    ...taskRoutes.automaticRepair({ resume, ...dependencies.lifecycleRepair }),
    operations: persistence.recoveryAdministration,
    ...(dependencies.lifecycleRepair.now === undefined
      ? {}
      : { now: dependencies.lifecycleRepair.now }),
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
    collaboration: routeDependencies.collaboration,
    participants,
    persistence,
    runtime,
    executionModule: taskExecutionModule,
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
    shutdown: persistence.shutdown,
    archive: createDrizzleTaskArchiveMaintenanceCommand(db),
    autoResume,
    repositoryPreparationRetry: dependencies.repositoryPreparationRetry,
    lifecycleRepair,
    lifecycleProjector: createDatabaseTaskLifecycleWsProjector(db),
    overview: createTaskOverviewQuery(db),
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
  readonly routes: (context: TaskExecutionProviderRouteContext) => Omit<
    PostgresqlTaskRouteOperationsDependencies,
    | 'db'
    | 'persistence'
    | 'children'
    | 'activity'
    | 'topology'
    | 'resumeRuntimeFor'
    | 'repositoryPreparationRetry'
    | 'launch'
    // RFC-359 AC-1（plan §5hn 批次二 ⑥）：启动参与者由本组合根装配后交进去，
    // 与 `launch` 同源——multipart 路由从此走它，不再手拼第二份编排。
    | 'launches'
    | 'repair'
  >
  readonly lifecycleRepair: Omit<AutomaticTaskRepairOptions, 'resume'>
  readonly fusion: Readonly<{ appHome: string }>
  readonly workgroupTaskRoom: Readonly<{
    readonly collaboration: WorkgroupTaskRoomClarifyParticipantFactory
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
  // RFC-359 AC-1（plan §5hn 批次二 ⑥）：装配一次，路由（JSON / multipart）与触发器三处共用。
  const launches = createPostgresqlTaskExecutionLaunchParticipant(routeLaunchDependencies)
  const repositoryPreparationRetry = createPostgresqlRepositoryPreparationRetryCommand({
    db,
    appHome: dependencies.routeWorkspace.appHome,
    workspace: createPostgresqlTaskWorkspaceMaterializer(workspaceDependencies),
    coordinator: dependencies.routeLaunch.coordinator,
    isTaskActive: participants.activity.isActive,
    awaitTaskSettled: participants.activity.awaitReleasedSettled,
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
    launches,
    repair: {
      collaborationRuntime: dependencies.runtime.collaborationRuntime,
      clarify: createPostgresqlClarifyRepairParticipant(db),
      review: createPostgresqlReviewRepairParticipant(db),
    },
    ...routeDependencies,
  })
  const cancellation = cancellationCommand(participants)
  const taskExecutions = createTaskExecutionTriggerParticipant({
    launches,
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
  const lifecycleRepair = createTaskLifecycleAutoRepairCommand({
    ...taskRoutes.automaticRepair({ resume, ...dependencies.lifecycleRepair }),
    operations: persistence.recoveryAdministration,
    ...(dependencies.lifecycleRepair.now === undefined
      ? {}
      : { now: dependencies.lifecycleRepair.now }),
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
    archive: createDrizzleTaskArchiveMaintenanceCommand(db),
    autoResume,
    repositoryPreparationRetry,
    lifecycleRepair,
    lifecycleProjector: createDatabaseTaskLifecycleWsProjector(db),
    overview: createTaskOverviewQuery(db),
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
    workgroupTaskRoom: composeWorkgroupTaskRoomTaskParticipantFactory({
      collaboration: dependencies.workgroupTaskRoom.collaboration,
    }),
    background,
  })
}

/**
 * 归档维护命令（boot 恢复 / 测试用）。
 *
 * RFC-359 W8-A 合一后这里不再按品牌分派：`createDrizzleTaskArchiveMaintenanceCommand` 是两个
 * provider 共用的**同一份**实现，客户端只是它的中立入参。保留这个具名工厂是为了让 boot 与测试
 * 有一个稳定的取用点（此前的分派语义见 W3-T15-B）。
 */
export function createTaskArchiveMaintenanceCommand(
  db: ProviderNeutralDatabase,
): TaskArchiveMaintenanceCommand {
  return createDrizzleTaskArchiveMaintenanceCommand(db)
}
