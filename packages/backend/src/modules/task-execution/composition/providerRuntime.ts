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
  composeLegacyTaskActivityParticipant,
  composeLegacyTaskStopRegistry,
  createTaskExecutionRuntimeParticipants,
  type TaskExecutionRuntimeParticipantsInput,
} from '../infrastructure/taskExecutionRuntimeParticipants'
import {
  createDatabaseTaskDriverLifecyclePort,
  createTaskDriverLifecyclePort,
} from '../infrastructure/taskDriverLifecycle'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { composePostgresqlMemoryInjectionQueries } from '@/modules/memory/composition'
import { composeRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { finishClaimedWebhookWorkspacePrune } from '@/platform/persistence/sqlite/systemWorkspaceGc'
import { createProviderTaskExecutionModule } from '../composition'
import { createRuntimeSessionLeaseOperations } from '../infrastructure/runtimeSessionLeaseOperations'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import { createLogger } from '@/util/log'
import {
  createTaskRouteOperations,
  type TaskRouteOperationsDependencies,
} from '../infrastructure/taskRouteOperations'
import { createDrizzleTaskArchiveMaintenanceCommand } from '../infrastructure/taskArchiveMaintenanceCommand'
import type { AutomaticTaskRepairOptions } from '../infrastructure/taskRouteRepairOperations'
import { createTaskLifecycleAutoRepairCommand } from './taskLifecycleRepair'
import { createDatabaseTaskLifecycleWsProjector } from '../infrastructure/taskLifecycleWsProjection'
import { createTaskOverviewQuery } from '../infrastructure/taskOverviewQuery'
import { createPostgresqlFusionEngineTaskOperations } from '../infrastructure/postgresqlFusionEngineTaskOperations'
import { createSqliteFusionEngineTaskOperations } from '../infrastructure/fusionEngineTaskOperations'
import {
  createRootTaskLaunchKernel,
  createTaskExecutionLaunchParticipant,
  createTaskRouteLaunchOperations,
  type RootTaskLaunchKernel,
  type TaskRouteLaunchDependencies,
} from '../infrastructure/taskRouteLaunchOperations'
import {
  createTaskRouteWorkspaceParticipant,
  createTaskWorkspaceMaterializer,
  type TaskRouteWorkspaceDependencies,
} from '../infrastructure/taskRouteWorkspaceParticipant'
import { createPostgresqlRepositoryPreparationRetryCommand } from '../infrastructure/postgresqlRepositoryPreparationRetryCommand'
import {
  createSqliteTaskExecutionLaunchParticipant,
  createSqliteTaskRouteLaunchOperations,
  type SqliteTaskRouteLaunchDependencies,
} from '../infrastructure/sqliteTaskRouteLaunchOperations'
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
    workflow?: RootTaskLaunchKernel
  }>
  readonly routes: Readonly<{
    readonly tasks: TaskRouteOperations
    readonly clarifyDirective: TaskClarifyDirectiveRouteOperations
  }>
  readonly background: TaskExecutionBackgroundControl
}

type SqliteRouteCollaborationContext = TaskRouteOperationsDependencies['collaboration']

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
    readonly workflow: RootTaskLaunchKernel
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

/**
 * RFC-359 AC-1（第 13 刀收尾）：`/api/tasks` 的依赖里**由组合根自己装**的那几格。
 *
 * 两支逐字相同——它们全是本文件手里现成的装配产物（运行时参与者、持久化、拓扑、启动参与者、
 * 资源权威与静态校验门），调用方的 `routes` 回调只需要补剩下那几格（协作上下文 / owner 目录 /
 * appHome 之类）。合并之前这份清单两支各写一份、还不一样长。
 */
type ProviderRouteOperationsAssembled =
  | 'db'
  | 'persistence'
  | 'children'
  | 'activity'
  | 'topology'
  | 'resumeRuntimeFor'
  | 'repositoryPreparationRetry'
  | 'resourceAuthorityFor'
  | 'validateHostWorkflow'
  | 'launches'
  | 'repair'

function cancellationCommand(
  participants: TaskExecutionRuntimeParticipants,
): TaskCancellationCommand {
  return Object.freeze({
    async cancel(input: Parameters<TaskCancellationCommand['cancel']>[0]) {
      await participants.children.cancel(input)
    },
  })
}

/**
 * RFC-359 AC-1（第 12 刀）：本组合根自己装的那几格由 `Omit` 划出去。
 *
 * `taskDagCollaboration` / `processConcurrencyScope` / `log` 此前是参与者工厂在体内现造的
 * （`createTaskDagCollaborationOperations(db)` / `db` / `createLogger('task')`），合一之后由
 * 这里照原样造——**装配决定，不是引擎差异**。三个端口（`lifecycle` / `activity` / `stop`）
 * 是这一支的部署形态：进程级单例的同步认领 + 进程内注册表。
 */
type SqliteRuntimeParticipantsAssembled =
  | 'db'
  | 'persistence'
  | 'codeHostConnections'
  | 'childLaunchWorkgroup'
  | 'taskDagCollaboration'
  | 'processConcurrencyScope'
  | 'log'
  | 'lifecycle'
  | 'activity'
  | 'stop'

export interface SqliteTaskExecutionProviderRuntimeDependencies<
  C extends SqliteRouteCollaborationContext = SqliteRouteCollaborationContext,
> {
  readonly runtime: Omit<
    TaskExecutionRuntimeParticipantsInput,
    // RFC-359 AC-1（plan §5hn 批次二 ⑤）：`childLaunchWorkgroup` 与 PostgreSQL 那一支同形——
    // 由本组合根从 `routeLaunch.workgroup` 取，装配方不必交第二份。
    SqliteRuntimeParticipantsAssembled
  > &
    Required<Pick<TaskExecutionRuntimeParticipantsInput, 'codeHostConnections'>>
  readonly routeLaunch: Omit<SqliteTaskRouteLaunchDependencies, 'db'>
  readonly routes: (context: TaskExecutionProviderRouteContext) => Omit<
    TaskRouteOperationsDependencies,
    // RFC-359 AC-1（第 13 刀收尾）：两个绑定合成一个中立工厂，于是这一档与 PostgreSQL 那一支
    // **逐字相同**——本函数手里现成的装配产物一律不劳调用方的 routes 回调再拼一遍。
    ProviderRouteOperationsAssembled
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
  const log = createLogger('task')
  const participants = createTaskExecutionRuntimeParticipants({
    db,
    persistence,
    ...dependencies.runtime,
    childLaunchWorkgroup: dependencies.routeLaunch.workgroup,
    taskDagCollaboration: createTaskDagCollaborationOperations(db),
    processConcurrencyScope: db,
    log,
    // RFC-359 AC-1（第 12 刀）：这一支的部署形态——进程级单例的同步认领
    //（执行上下文带 `legacyConnection`）+ 进程内注册表的活跃度 / 停机票据。
    lifecycle: createDatabaseTaskDriverLifecyclePort({
      db,
      log,
      finalizeWorkspace: async (taskId: string) => {
        await finishClaimedWebhookWorkspacePrune(db, taskId)
      },
    }),
    activity: composeLegacyTaskActivityParticipant(),
    stop: composeLegacyTaskStopRegistry(),
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
  // RFC-359 AC-1（第 13 刀收尾）：`/api/tasks` 只剩一个工厂，两支各自交自己的装配产物。
  const taskRoutes = createTaskRouteOperations({
    db,
    launches,
    resourceAuthorityFor: dependencies.routeLaunch.resourceAuthorityFor,
    validateHostWorkflow: (definition, candidate) =>
      dependencies.routeLaunch.agent.resources.validateHostWorkflow(definition, candidate),
    activity: participants.activity,
    persistence,
    children: participants.children,
    topology: runtime.topology,
    resumeRuntimeFor: (_actor, taskId) => dependencies.rootResumeRuntime(taskId),
    repositoryPreparationRetry: dependencies.repositoryPreparationRetry,
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

/**
 * RFC-359 AC-1（第 12 刀）：PostgreSQL 这一支的运行时装配面。
 *
 * 此前它是 `infrastructure/postgresqlTaskExecutionRuntimeParticipants.ts` 的入参接口，而那个
 * 文件干的事全是**装配**（现造持久化 / 执行模块 / 会话租约 / 记忆注入 / 运行时档案注册表，
 * 再挑一条认领策略），一行适配逻辑都没有。按 RFC-294 装配归 `composition/`，所以它整条搬到
 * 这里，跟本支其余的装配放在一起；参与者实现只剩中立的那一份。
 */
export interface PostgresqlTaskExecutionRuntimeDependencies extends Omit<
  TaskExecutionRuntimeParticipantsInput,
  | 'db'
  | 'persistence'
  | 'runtimeSessionLeases'
  | 'memoryInjectionQueries'
  | 'runtimeRegistry'
  | 'childLaunchWorkgroup'
> {
  readonly childLaunchWorkgroup: TaskExecutionRuntimeParticipantsInput['childLaunchWorkgroup']
  /** 装配方选定的凭据读取面；PostgreSQL 执行绝不回头开一条 SQLite 兜底。 */
  readonly codeHostConnections: CodeHostConnectionsService
  /** 落进所有权租约的确切进程代号。 */
  readonly daemonGeneration: string
  /** Source-control 选定的终态工作区收尾器。 */
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  /** 可选的预装实例，让一个 bootstrap 能共享同一批聚合。 */
  readonly persistence?: TaskExecutionPersistence
  readonly runtimeSessionLeases?: RuntimeSessionLeaseOperations
  /** 让启动 / 取消装配共享同一道认领闸门与进程注册表。 */
  readonly executionModule?: ProviderTaskExecutionModule
}

export interface PostgresqlTaskExecutionProviderRuntimeDependencies {
  readonly runtime: Omit<PostgresqlTaskExecutionRuntimeDependencies, 'childLaunchWorkgroup'>
  readonly rootResumeRuntime: (taskId: string) => ChildResumeRuntime
  readonly routeLaunch: Omit<TaskRouteLaunchDependencies, 'db' | 'workspace'>
  readonly routeWorkspace: Omit<TaskRouteWorkspaceDependencies, 'db'>
  readonly routes: (
    context: TaskExecutionProviderRouteContext,
  ) => Omit<TaskRouteOperationsDependencies, ProviderRouteOperationsAssembled>
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
  const persistence = dependencies.runtime.persistence ?? createTaskExecutionPersistence(db)
  const executionModule =
    dependencies.runtime.executionModule ??
    createProviderTaskExecutionModule({
      daemonGeneration: dependencies.runtime.daemonGeneration,
      persistence,
    })
  // RFC-359 AC-1（第 12 刀）：这一支的部署形态——持久化租约认领 + 注入的执行模块注册表。
  const activity = Object.freeze({
    isActive: (taskId: string) => executionModule.runtimeRegistry.hasTask(taskId),
    // 不能是空桩：共用实现靠它做两阶段停机的等待（见 `resumeTaskProjection` 的头注）。
    awaitReleasedSettled: (taskId: string) =>
      executionModule.runtimeRegistry.awaitReleasedSettled(taskId),
  })
  const participants = createTaskExecutionRuntimeParticipants({
    ...dependencies.runtime,
    db,
    persistence,
    runtimeSessionLeases:
      dependencies.runtime.runtimeSessionLeases ?? createRuntimeSessionLeaseOperations(db),
    memoryInjectionQueries: composePostgresqlMemoryInjectionQueries(db),
    runtimeRegistry: composeRuntimeRegistryOperations(db),
    childLaunchWorkgroup: dependencies.routeLaunch.workgroup,
    lifecycle: createTaskDriverLifecyclePort({
      db,
      module: executionModule,
      claim: (intentId) => executionModule.claimPersisted({ intentId }),
      persistence,
      log: dependencies.runtime.log,
      finalizeWorkspace: dependencies.runtime.finalizeWorkspace,
    }),
    activity,
    stop: executionModule.runtimeRegistry,
  })
  const runtime = composeTaskExecutionRuntime({ participants, readModels: persistence.reads })
  const workspaceDependencies: TaskRouteWorkspaceDependencies = {
    db,
    ...dependencies.routeWorkspace,
  }
  const routeWorkspace = createTaskRouteWorkspaceParticipant(workspaceDependencies)
  const taskRouteLaunchDependencies: Omit<TaskRouteLaunchDependencies, 'db'> = {
    workspace: routeWorkspace,
    ...dependencies.routeLaunch,
  }
  const routeLaunchDependencies: TaskRouteLaunchDependencies = {
    db,
    ...taskRouteLaunchDependencies,
  }
  const routeLaunch = createTaskRouteLaunchOperations(routeLaunchDependencies)
  // RFC-359 AC-1（plan §5hn 批次二 ⑥）：装配一次，路由（JSON / multipart）与触发器三处共用。
  const launches = createTaskExecutionLaunchParticipant(routeLaunchDependencies)
  const repositoryPreparationRetry = createPostgresqlRepositoryPreparationRetryCommand({
    db,
    appHome: dependencies.routeWorkspace.appHome,
    workspace: createTaskWorkspaceMaterializer(workspaceDependencies),
    coordinator: dependencies.routeLaunch.coordinator,
    isTaskActive: participants.activity.isActive,
    awaitTaskSettled: participants.activity.awaitReleasedSettled,
    log: dependencies.runtime.log,
  })
  const routeDependencies = dependencies.routes({
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
  })
  const taskRoutes = createTaskRouteOperations({
    db,
    persistence,
    children: participants.children,
    activity: participants.activity,
    topology: runtime.topology,
    resumeRuntimeFor: (_actor, taskId) => dependencies.rootResumeRuntime(taskId),
    repositoryPreparationRetry,
    resourceAuthorityFor: taskRouteLaunchDependencies.resourceAuthorityFor,
    validateHostWorkflow: (definition, candidate) =>
      taskRouteLaunchDependencies.agent.resources.validateHostWorkflow(definition, candidate),
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
    module: executionModule,
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
    executionModule,
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
      executionModule,
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
      workflow: createRootTaskLaunchKernel(routeLaunchDependencies),
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
