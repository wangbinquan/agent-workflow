import type { TaskDriveCoordinatorFactory } from '../application/drive/taskDriveCoordinatorFactory'
import type { TaskDriverLifecyclePort } from '../application/drive/taskDriveCoordinator'
import type { TaskRecoveryProviderSelection } from './taskRecoverySelection'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
} from '@/modules/source-control/public/queries'
import { composePortArtifactOperations } from './portArtifacts'
import { join } from 'node:path'
import { composeNodeRunPromptOperations } from './nodeRunPrompts'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { FusionEngineTaskOperations } from '@/modules/knowledge-evolution/public/participants'
import {
  createClarifyRepairParticipant,
  createReviewRepairParticipant,
} from '@/modules/collaboration/composition'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import type { TaskExecutionModule } from '../composition'
import type { TaskExecutionBinding } from './taskExecutionBinding'
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
import type {
  ChildResumeRuntime,
  SchedulerDriverPort,
} from '../application/ports/taskExecutionTopology'
import type {
  AgentRouteTaskLaunchOperations,
  TaskCancellationCommand,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import type { TaskOverviewQuery } from '../public/queries'
import type { TaskClarifyDirectiveRouteOperations, TaskExecutionReadModels } from '../public/types'
import type { TaskRouteOperations } from '../public/taskRoutes'
import {
  createTaskExecutionRuntimeParticipants,
  type TaskExecutionRuntimeParticipantsInput,
} from '../infrastructure/taskExecutionRuntimeParticipants'
import {
  composeTaskWorkspaceExcludeProfilesFor,
  bindProviderTaskRunParticipantsInput,
  type ProviderTaskRunBindingSelection,
} from './localTaskRunSelection'
import { createTaskDriverLifecyclePort } from '../infrastructure/taskDriverLifecycle'
import {
  createTaskRouteOperations,
  type TaskRouteOperationsDependencies,
} from '../infrastructure/taskRouteOperations'
import {
  createDrizzleTaskArchiveMaintenanceCommand,
  type TaskArchiveContentBinding,
} from './taskArchiveMaintenance'
import type { AutomaticTaskRepairOptions } from '../infrastructure/taskRouteRepairOperations'
import { createTaskLifecycleAutoRepairCommand } from './taskLifecycleRepair'
import { createDatabaseTaskLifecycleWsProjector } from '../infrastructure/taskLifecycleWsProjection'
import { createTaskOverviewQuery } from './taskOverview'
import { createFusionEngineTaskOperations } from '../infrastructure/fusionEngineTaskOperations'
import {
  createRootTaskLaunchKernel,
  createTaskExecutionLaunchParticipant,
  createTaskRouteLaunchOperations,
  type RootTaskLaunchKernel,
  type TaskRouteLaunchDependencies,
} from '../infrastructure/taskRouteLaunchOperations'
import {
  createTaskRouteWorkspaceParticipant,
  type TaskRouteWorkspaceDependencies,
} from '../infrastructure/taskRouteWorkspaceParticipant'
import { createRepositoryPreparationRetryCommand } from '../infrastructure/repositoryPreparationRetryCommand'
import { composeTaskExecutionRuntime, type TaskExecutionRuntime } from './runtimeAssembly'
import { composeTaskAutoResumeCommand } from './taskAutoResume'
import { composeTaskClarifyDirectiveRouteOperations } from './taskClarifyDirectiveRoutes'
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

type RouteCollaborationContext = TaskRouteOperationsDependencies['collaboration']

export interface SelectedTaskExecutionProviderRuntime<
  C extends RouteCollaborationContext = RouteCollaborationContext,
> {
  readonly driverLifecycle: TaskDriverLifecyclePort
  readonly launches: ReturnType<typeof createTaskExecutionLaunchParticipant>
  readonly collaboration: C
  readonly workgroupTaskRoom: WorkgroupTaskRoomTaskParticipantFactory
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
    workflow: RootTaskLaunchKernel
  }>
  readonly routes: Readonly<{
    readonly tasks: TaskRouteOperations
    readonly clarifyDirective: TaskClarifyDirectiveRouteOperations
  }>
  readonly background: TaskExecutionBackgroundControl
}

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
  | 'workspaceReads'
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

/** RFC-388: one passive graph; callers select deployment bindings and shared participants. */
export interface TaskExecutionProviderRuntimeDependencies<
  C extends RouteCollaborationContext = RouteCollaborationContext,
> {
  readonly db: ProviderNeutralDatabase
  readonly persistence: TaskExecutionPersistence
  readonly execution: TaskExecutionBinding
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly log: TaskExecutionRuntimeParticipantsInput['log']
  readonly coordinatorFactory: TaskDriveCoordinatorFactory
  readonly schedulerDriver?: SchedulerDriverPort
  readonly archive?: TaskArchiveContentBinding
  readonly recoverySelection?: TaskRecoveryProviderSelection
  readonly workspaceReads?: RepositoryWorkspaceReadQueries
  readonly runtime: Omit<
    TaskExecutionRuntimeParticipantsInput,
    | 'db'
    | 'persistence'
    | 'childLaunchWorkgroup'
    | 'taskRunBinding'
    | 'workspaceExcludeProfilesFor'
    | 'log'
  > &
    Required<Pick<TaskExecutionRuntimeParticipantsInput, 'codeHostConnections'>> &
    ProviderTaskRunBindingSelection &
    Partial<Pick<TaskExecutionRuntimeParticipantsInput, 'workspaceExcludeProfilesFor'>>
  readonly rootResumeRuntime: (taskId: string) => ChildResumeRuntime | Promise<ChildResumeRuntime>
  readonly routeLaunch: Omit<TaskRouteLaunchDependencies, 'db' | 'workspace'>
  readonly routeWorkspace: Omit<TaskRouteWorkspaceDependencies, 'db'>
  readonly routes: (context: TaskExecutionProviderRouteContext) => Omit<
    TaskRouteOperationsDependencies,
    ProviderRouteOperationsAssembled
  > & {
    readonly collaboration: C
  }
  readonly lifecycleRepair: Omit<AutomaticTaskRepairOptions, 'resume'>
  readonly fusion: Omit<
    Parameters<typeof createFusionEngineTaskOperations>[0],
    'db' | 'coordinator' | 'cancellation'
  >
  readonly workgroupTaskRoom: Readonly<{
    readonly collaboration: WorkgroupTaskRoomClarifyParticipantFactory
  }>
}

export function composeTaskExecutionProviderRuntime<C extends RouteCollaborationContext>(
  dependencies: TaskExecutionProviderRuntimeDependencies<C>,
): SelectedTaskExecutionProviderRuntime<C> {
  const { db, persistence, execution, finalizeWorkspace, log } = dependencies
  const workspaceReads = selectRepositoryWorkspaceReadQueries(dependencies.workspaceReads)
  const executionModule = execution.module
  const driverLifecycle = createTaskDriverLifecyclePort({
    db,
    module: executionModule,
    claim: execution.claim,
    legacyConnection: execution.legacyConnection,
    persistence,
    log,
    finalizeWorkspace,
  })
  const activity = Object.freeze({
    isActive: (taskId: string) => executionModule.runtimeRegistry.hasTask(taskId),
    // 不能是空桩：共用实现靠它做两阶段停机的等待（见 `resumeTaskProjection` 的头注）。
    awaitReleasedSettled: (taskId: string) =>
      executionModule.runtimeRegistry.awaitReleasedSettled(taskId),
  })
  const participants = createTaskExecutionRuntimeParticipants(
    bindProviderTaskRunParticipantsInput(
      {
        ...dependencies.runtime,
        workspaceExcludeProfilesFor:
          dependencies.runtime.workspaceExcludeProfilesFor === undefined
            ? composeTaskWorkspaceExcludeProfilesFor()
            : dependencies.runtime.workspaceExcludeProfilesFor,
        db,
        persistence,
        log,
        childLaunchWorkgroup: dependencies.routeLaunch.workgroup,
        coordinatorFactory: dependencies.coordinatorFactory,
        activity,
        stop: executionModule.runtimeRegistry,
      },
      {
        nodeRunPromptsFor: (appHome) =>
          composeNodeRunPromptOperations(undefined, join(appHome, 'runs')),
        portArtifactsFor: (appHome) => composePortArtifactOperations(undefined, appHome),
      },
    ),
  )
  const composedRuntime = composeTaskExecutionRuntime({
    participants,
    readModels: persistence.reads,
  })
  const runtime =
    dependencies.schedulerDriver === undefined
      ? composedRuntime
      : Object.freeze({
          ...composedRuntime,
          schedulerDriver: dependencies.schedulerDriver,
          topology: Object.freeze({ schedulerDriver: dependencies.schedulerDriver }),
        })
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
  const repositoryPreparationRetry = createRepositoryPreparationRetryCommand({
    db,
    coordinator: dependencies.coordinatorFactory.session,
    isTaskActive: participants.activity.isActive,
    awaitTaskSettled: participants.activity.awaitReleasedSettled,
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
    // The REST / MCP actor reaches the continuation: only an actor command may
    // authorize replaying an operation of unknown outcome (RFC-370 hosted
    // acceptance, 2026-10-17; the SQLite route passes it the same way).
    resumeRuntimeFor: async (actor, taskId) => ({
      ...(await dependencies.rootResumeRuntime(taskId)),
      actorUserId: actor.user.id,
    }),
    repositoryPreparationRetry,
    resourceAuthorityFor: taskRouteLaunchDependencies.resourceAuthorityFor,
    validateHostWorkflow: (definition, candidate) =>
      taskRouteLaunchDependencies.agent.resources.validateHostWorkflow(definition, candidate),
    launches,
    repair: {
      collaborationRuntime: dependencies.runtime.collaborationRuntime,
      clarify: createClarifyRepairParticipant(db),
      review: createReviewRepairParticipant(db),
    },
    ...routeDependencies,
    workspaceReads,
  })
  const cancellation = cancellationCommand(participants)
  const taskExecutions = createTaskExecutionTriggerParticipant({
    launches,
    cancellation,
  })
  const resume = Object.freeze({
    async resume(taskId: string) {
      await participants.children.resume(
        { taskId, runtime: await dependencies.rootResumeRuntime(taskId) },
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
  const recoveryConsumer = dependencies.recoverySelection?.({
    db,
    assertManualExecutionAllowed: taskRoutes.assertManualExecutionAllowed,
    async resumeTaskAs(actor, taskId) {
      await taskRoutes.resume({ actor, taskId })
    },
  })
  const background = composeTaskExecutionProviderBackground({
    ...(recoveryConsumer === undefined ? {} : { recoveryConsumer }),
    module: executionModule,
    lifecycleRepair,
    autoResume,
    recovery: persistence.recoveryAdministration,
    taskHasDriver: runtime.schedulerDriver.isTaskActive,
    buildScheduleLaunch,
  })
  return Object.freeze({
    driverLifecycle,
    launches,
    collaboration: routeDependencies.collaboration,
    participants,
    persistence,
    runtime,
    executionModule,
    readModels: persistence.reads,
    recovery: persistence.recoveryAdministration,
    shutdown: persistence.shutdown,
    archive: createDrizzleTaskArchiveMaintenanceCommand(db, dependencies.archive),
    autoResume,
    repositoryPreparationRetry,
    lifecycleRepair,
    lifecycleProjector: createDatabaseTaskLifecycleWsProjector(db),
    overview: createTaskOverviewQuery(db),
    fusion: createFusionEngineTaskOperations({
      db,
      ...dependencies.fusion,
      coordinator: dependencies.coordinatorFactory.session,
      cancellation,
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
  archive?: TaskArchiveContentBinding,
): TaskArchiveMaintenanceCommand {
  return createDrizzleTaskArchiveMaintenanceCommand(db, archive)
}
