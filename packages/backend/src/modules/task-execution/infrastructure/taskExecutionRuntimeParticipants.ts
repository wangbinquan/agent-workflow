import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  CollaborationRuntimeMechanics,
  TaskDagCollaborationOperations,
} from '@/modules/collaboration/public/participants'
import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import type { MemoryInjectionQueries } from '@/modules/memory/public/queries'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import type { DynamicWorkflowValidationContextSource } from '@/services/dynamicWorkflowRunner'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type { RuntimeRegistryOperations } from '@/services/runtimeRegistry'
import { isTaskActive } from '@/services/task'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import type {
  ActiveTaskExecutionParticipant,
  TaskExecutionDriveParticipant,
  TaskExecutionRuntimeParticipants,
} from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { WorkgroupTurnsOperations } from '../application/ports/workgroupTurnsOperations'
import { composeExecutionMergeRecovery } from '../composition/executionMergeRecovery'
import { driveTaskEngineApplication } from '../composition/taskEngineApplication'
import { composeWrapperRuntime } from '../composition/wrapperRuntime'
import { taskExecutionModule } from '../public/participants'
import {
  createChildExecutionLaunchOperations,
  type ChildWorkgroupLaunchResources,
} from './childExecutionLaunchOperations'
import {
  createChildTaskLifecycleParticipant,
  type ChildTaskLifecycleRuntimePorts,
} from './childTaskLifecycleParticipant'
import { awaitTaskDriverReleasedSettled } from './taskDriverLifecycle'

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
 *   · `lifecycle`：SQLite 绑进程级单例的同步认领（`createDatabaseTaskDriverLifecyclePort`），
 *     PostgreSQL 绑持久化租约（`claimPersisted`）；
 *   · `activity` / `stop`：SQLite 读进程内注册表（`composeLegacyTaskActivityParticipant` /
 *     `composeLegacyTaskStopRegistry`），PostgreSQL 读注入的 `executionModule.runtimeRegistry`。
 *
 * 按 plan §5fq 的判据，这三格命中的是**部署形态**而不是 ①②③ 里的任何一条，所以它们是
 * **端口**：一份实现、两个绑定，绑定由各自的组合根（`composition/providerRuntime.ts`）交。
 * 剩下那十来格（持久化 / 会话租约 / 记忆注入 / 运行时档案 / 协作 / 并发域 / 日志）此前之所以
 * 看起来「两侧不同」，只是**谁来构造**的差别——SQLite 由装配方交、PG 在工厂里现造；
 * 那从来不是引擎差异，合并后一律由装配方交。
 */
export interface TaskExecutionRuntimeParticipantsInput {
  readonly db: ProviderNeutralDatabase
  readonly persistence: TaskExecutionPersistence
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  readonly memoryInjectionQueries: MemoryInjectionQueries
  /** 运行时**档案**注册表（`getRuntime(name)`）——与下面的 `stop` 同名不同物。 */
  readonly runtimeRegistry: RuntimeRegistryOperations
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
  const runtimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })
  const childLaunch = createChildExecutionLaunchOperations({
    db: input.db,
    persistence: input.persistence,
    // 认领走哪条路由组合根决定；铸造机自己不再有引擎判断。
    lifecycle: input.lifecycle,
    workgroup: input.childLaunchWorkgroup,
  })

  const drive: TaskExecutionDriveParticipant = Object.freeze({
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
      persistence: input.persistence,
      runtimeSessionLeases: input.runtimeSessionLeases,
      log: input.log,
      lifecycle: input.lifecycle,
      activity: input.activity,
      stop: input.stop,
    }),
    activity: input.activity,
  })
}

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：进程内活跃度参与者的**唯一**装配点。
 *
 * 它包的就是进程内注册表（`isTaskActive` / `awaitTaskDriverReleasedSettled`），
 * 行为与直呼那两个全局一模一样；价值在**边界**：路由与 `delete` 现在读的是注入的端口，
 * 于是两个引擎上都能把 `task-active` 那道门喂出来（此前 SQLite 侧驱不动模块全局，
 * W7 的 A19 因此一直缺这一格）。`server.ts` 那条不装配完整 runtime 的路也用它，
 * 免得同一个包装在仓里出现第二份。
 */
export function composeLegacyTaskActivityParticipant(): ActiveTaskExecutionParticipant {
  return Object.freeze({
    isActive: isTaskActive,
    awaitReleasedSettled: awaitTaskDriverReleasedSettled,
  })
}

/**
 * RFC-359 AC-1（第 12 刀）：进程级单例那套**停机票据**注册表的唯一取用点。
 *
 * 与上面那个是同一套进程内注册表的两个面（一个问「谁在跑」，一个问「请它停」）。
 * 单进程部署形态（SQLite）绑它；持久化租约部署形态（PostgreSQL）绑
 * `executionModule.runtimeRegistry`。
 *
 * ⚠️ 不能按名字抓：参与者输入里那个 `runtimeRegistry` 是 `platform/runtime-registry` 的
 * **运行时档案**注册表（`getRuntime(name)`），与这里的停机票据注册表**同名不同物**。
 */
export function composeLegacyTaskStopRegistry(): ChildTaskLifecycleRuntimePorts['stop'] {
  return taskExecutionModule.runtimeRegistry
}
