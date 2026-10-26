import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import type {
  IsolationWorkspaceFactory,
  RepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/types'
import {
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import type { NodeRunRuntimePersistence } from '@/modules/task-execution/application/ports/nodeRunRuntimePersistence'
import type { CallObservations } from '@/modules/run-observability/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  CollaborationRuntimeMechanics,
  TaskDagCollaborationOperations,
} from '@/modules/collaboration/public/participants'
import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import type { MemoryInjectionQueries } from '@/modules/memory/public/queries'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import type { DynamicWorkflowValidationContextSource } from '@/services/dynamicWorkflowRunner'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import type {
  TaskExecutionDriveParticipant,
  TaskExecutionRuntimeParticipants,
} from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { WorkgroupTurnsOperations } from '../application/ports/workgroupTurnsOperations'
import { composeExecutionMergeRecovery } from '../composition/executionMergeRecovery'
import { driveTaskEngineApplication } from '../composition/taskEngineApplication'
import { composeWrapperRuntime } from '../composition/wrapperRuntime'
import {
  createChildExecutionLaunchOperations,
  type ChildWorkgroupLaunchResources,
} from './childExecutionLaunchOperations'
import {
  createChildTaskLifecycleParticipant,
  type ChildTaskLifecycleRuntimePorts,
} from './childTaskLifecycleParticipant'

/**
 * RFC-359 AC-1（第 12 刀）—— 运行时参与者的**唯一**实现，两个 provider 共用。
 *
 * 合并之前这里是一对同目录孪生（`sqlite…` 189 行 / `postgresql…` 160 行）。W8 当年判「不合」，
 * 理由写的是「两台 children 引擎 + 两个 registry」——**那条理由今天已经不成立**：
 *   · children 的两台引擎在第 10 / 11 刀合成了 `resumeTaskProjection` / `cancelTaskProjection`；
 *   · 子任务铸造机在批次二 ⑤ 合成了 `createChildExecutionLaunchOperations`；
 *   · drive 的内核本来就是同一个 `driveTaskEngineApplication`。
 *
 * 逐格量完，两侧真正剩下的差异只有**三个端口**，而且三个说的是同一件事——
 * 「这台部署里，谁在跑、怎么认领、怎么请它停」：
 *   · `coordinatorFactory`：RFC-386 会话工厂封装生命周期，SQLite 绑进程级单例的
 *     同步认领（`createDatabaseTaskDriverLifecyclePort`），PostgreSQL 绑持久化租约（`claimPersisted`）；
 *   · `activity` / `stop`：RFC-388 两个部署都读注入执行模块的运行注册表。
 *
 * 按 plan §5fq 的判据，这三格命中的是**部署形态**而不是 ①②③ 里的任何一条，所以它们是
 * **端口**：一份实现、两个绑定，绑定由各自的组合根（`composition/providerRuntime.ts`）交。
 * 剩下那十来格（持久化 / 会话租约 / 记忆注入 / 运行时档案 / 协作 / 并发域 / 日志）此前之所以
 * 看起来「两侧不同」，只是**谁来构造**的差别——SQLite 由装配方交、PG 在工厂里现造；
 * 那从来不是引擎差异，合并后一律由装配方交。
 */
import { taskRunBindingPending, type TaskRunDriveBinding } from '../composition/taskRunSelection'

export interface TaskExecutionRuntimeParticipantsInput {
  readonly historyRestrictions: HistoryRestrictionPort
  readonly workspacePresence: WorkspacePresenceQueries
  readonly observationInvocations: CallObservations
  readonly db: PersistenceDb
  readonly persistence: TaskExecutionPersistence
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  readonly memoryInjectionQueries: MemoryInjectionQueries
  /** 运行时**档案**注册表（`getRuntime(name)`）——与下面的 `stop` 同名不同物。 */
  readonly runtimeRegistry: RuntimeExecutionQueries
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly taskRunBinding: TaskRunDriveBinding
  readonly workspaceExcludeProfilesFor: (
    request: Parameters<TaskExecutionDriveParticipant['drive']>[0],
  ) => WorkspaceExcludeProfileFactory
  readonly isolationWorkspaces?: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  readonly operationConfiguration?: TaskOperationConfigurationQueries
  readonly taskDagCollaboration: TaskDagCollaborationOperations
  readonly collaborationRuntime: CollaborationRuntimeMechanics
  readonly workgroupTurns: WorkgroupTurnsOperations
  /**
   * 子任务（call 节点）铸造机的工作组资源面：交的是路由启动那份
   * `composeWorkgroupLaunchResourceOperations` 的产物——两个组合根同一份实现。
   */
  readonly childLaunchWorkgroup: ChildWorkgroupLaunchResources
  readonly dynamicWorkflow: Readonly<{
    readonly persistence: DynamicWorkflowPersistence
    readonly validationContext: DynamicWorkflowValidationContextSource
  }>
  readonly identityAccess: Readonly<{
    readonly delegatedRequests: DelegatedRequestAuthorityFactory
    readonly taskExecutionResources: TaskExecutionResourceBinding
  }>
  readonly repositoryPublicationTransport: RepositoryPublicationTransport
  /** 装配方选定的凭据读取面；参与者自己绝不回头重建一份。 */
  readonly codeHostConnections?: CodeHostConnectionsService
  /** 进程信号量共享用的守护进程级身份。 */
  readonly processConcurrencyScope: object
  readonly log: TaskExecutionTopologyLogger
}

/**
 * 运行时参与者的**唯一**工厂。两个 provider 都叫它，差别只在
 * {@link ChildTaskLifecycleRuntimePorts} 那三格由各自组合根绑什么。
 */
export function createTaskExecutionRuntimeParticipants(
  input: TaskExecutionRuntimeParticipantsInput & ChildTaskLifecycleRuntimePorts,
): TaskExecutionRuntimeParticipants {
  const isolationWorkspaces = selectIsolationWorkspaceFactory(input.isolationWorkspaces)
  const repositoryGitWorkspaces = selectRepositoryGitWorkspaceFactory(input.repositoryGitWorkspaces)
  const runtimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })
  const childLaunch = createChildExecutionLaunchOperations({
    db: input.db,
    persistence: input.persistence,
    // 会话工厂持有认领端口与实时配置；铸造机只选择子任务画像。
    coordinatorFactory: input.coordinatorFactory,
    workgroup: input.childLaunchWorkgroup,
  })

  const drive: TaskExecutionDriveParticipant = Object.freeze({
    async drive(
      request: Parameters<TaskExecutionDriveParticipant['drive']>[0],
      topology: Parameters<TaskExecutionDriveParticipant['drive']>[1],
    ) {
      const driveOptions = {
        ...request,
        observationInvocations: input.observationInvocations,
        memoryInjectionQueries: input.memoryInjectionQueries,
        persistence: input.persistence,
        runtimeSessionLeases: input.runtimeSessionLeases,
        runtimeRegistry: input.runtimeRegistry,
        nodeRunRuntime: input.nodeRunRuntime,
        isolationWorkspaces,
        repositoryGitWorkspaces,
        ...(input.operationConfiguration === undefined
          ? {}
          : { operationConfiguration: input.operationConfiguration }),
        taskDagCollaboration: input.taskDagCollaboration,
        collaborationRuntime: input.collaborationRuntime,
        workgroupTurns: input.workgroupTurns,
        childLaunch,
        processConcurrencyScope: input.processConcurrencyScope,
        identityAccess: input.identityAccess,
        ...(input.codeHostConnections === undefined
          ? {}
          : { codeHostConnections: input.codeHostConnections }),
        repositoryPublicationTransport: input.repositoryPublicationTransport,
        dynamicWorkflow: input.dynamicWorkflow,
      }
      const pendingRuns = input.taskRunBinding.bind(request, {
        nodeRunRuntime: driveOptions.nodeRunRuntime,
        runtimeRegistry: driveOptions.runtimeRegistry,
        ...(driveOptions.operationConfiguration === undefined
          ? {}
          : { operationConfiguration: driveOptions.operationConfiguration }),
      })
      const taskRuns = taskRunBindingPending(pendingRuns) ? await pendingRuns : pendingRuns
      await driveTaskEngineApplication(
        {
          ...driveOptions,
          ...taskRuns,
          workspaceExcludeProfiles: input.workspaceExcludeProfilesFor(driveOptions),
        },
        topology,
        runtimeComponents,
      )
    },
  })

  return Object.freeze({
    drive,
    children: createChildTaskLifecycleParticipant({
      db: input.db,
      historyRestrictions: input.historyRestrictions,
      persistence: input.persistence,
      runtimeSessionLeases: input.runtimeSessionLeases,
      workspacePresence: input.workspacePresence,
      log: input.log,
      coordinatorFactory: input.coordinatorFactory,
      activity: input.activity,
      stop: input.stop,
    }),
    activity: input.activity,
  })
}
