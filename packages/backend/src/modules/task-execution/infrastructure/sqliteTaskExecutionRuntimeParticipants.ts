import type { DbClient } from '@/db/client'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import type { MemoryInjectionQueries } from '@/modules/memory/public/queries'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import { cancelTask, isTaskActive, resumeTask } from '@/services/task'
import { awaitTaskDriverReleasedSettled } from './taskDriverLifecycle'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type {
  ActiveTaskExecutionParticipant,
  TaskExecutionRuntimeParticipants,
} from '../application/ports/taskExecutionRuntimeParticipants'
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
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import type { WorkgroupTurnsOperations } from '../application/ports/workgroupTurnsOperations'
import { createPostgresqlChildExecutionLaunchOperations } from './postgresqlChildExecutionLaunchOperations'
import type { PostgresqlChildWorkgroupLaunchResources } from './postgresqlChildExecutionLaunchOperations'
import { createDatabaseTaskDriverLifecyclePort } from './taskDriverLifecycle'
import { finishClaimedWebhookWorkspacePrune } from '@/platform/persistence/sqlite/systemWorkspaceGc'
import { createLogger } from '@/util/log'

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
  /** RFC-359 W4-D19c：工作组回合操作，由 bootstrap 用 `composeWorkgroupTurnsOperations` 装好交进来。 */
  readonly workgroupTurns: WorkgroupTurnsOperations
  readonly dynamicWorkflow: Readonly<{
    readonly persistence: DynamicWorkflowPersistence
    readonly validationContext: DynamicWorkflowValidationContextSource
  }>
  readonly identityAccess: Readonly<{
    readonly delegatedRequests: DelegatedRequestAuthorityFactory
    readonly taskExecutionResources: TaskExecutionResourceBinding
  }>
  readonly repositoryPublicationTransport: RepositoryPublicationTransport
  /** Bootstrap-selected credential reader; never reconstructed from SQLite here. */
  readonly codeHostConnections?: CodeHostConnectionsService
  /**
   * RFC-359 AC-1（plan §5hn 批次二 ⑤）：子任务铸造机的工作组资源面。与 PG 组合根同名一格
   * （`childLaunchWorkgroup`），交的是路由启动那份 `composeWorkgroupLaunchResourceOperations`
   * 的产物——两个组合根同一份实现。
   */
  readonly childLaunchWorkgroup: PostgresqlChildWorkgroupLaunchResources
}): TaskExecutionRuntimeParticipants {
  const runtimeComponents = Object.freeze({
    wrapperRuntimeFactory: composeWrapperRuntime,
    mergeRecoveryFactory: composeExecutionMergeRecovery,
  })
  // RFC-359 AC-1（plan §5hn 批次二 ⑤）：子任务（call 节点）两个引擎共用同一台铸造机。
  // 此前 SQLite 这一格是 87 行的转发壳 → `startExecution` → `startTaskImpl`（那台通用启动器
  // 同时服务 root / 定时 / webhook / 事件 / agent / 工作组），PG 那侧是一台 740 行的专用铸造机。
  // W8-A 已经把两侧的**门**抬齐（5 道亲子准入 + 冻结定义的启动输入门），批次二 ⑤（上）又把
  // **落库那几行**钉成了相等面（整行 + 四张卫星表，单侧变异实证过两条）；这里做的是合一本身。
  //
  // **引擎差只剩这一格**：驱动生命周期端口的拼法——SQLite 绑进程级单例的
  // `claim({ db, intentId })` 且执行上下文要带 `legacyConnection`（`services/task` 那条启动路
  // 尚未退役的残留），PG 绑实例的 `claimPersisted({ intentId })`。两条拼法本来就并存于
  // `taskDriverLifecycle.ts`，端口化之后由组合根各取各的，铸造机自己不再有引擎判断。
  //
  // `finalizeWorkspace` 逐字沿用 SQLite 今天这条路上用的那一个（`services/task.ts` 的协调器
  // 装的就是它）——本刀是合一，不顺手改收尾语义。两个引擎的 finalize 绑的不是同一个函数，
  // 那条差异单独记在 plan 里待裁决。
  const childLaunch = createPostgresqlChildExecutionLaunchOperations({
    db: input.db,
    persistence: input.persistence,
    lifecycle: createDatabaseTaskDriverLifecyclePort({
      db: input.db,
      log: createLogger('task'),
      finalizeWorkspace: async (taskId) => {
        await finishClaimedWebhookWorkspacePrune(input.db, taskId)
      },
    }),
    workgroup: input.childLaunchWorkgroup,
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
          taskDagCollaboration: createTaskDagCollaborationOperations(input.db),
          collaborationRuntime: input.collaborationRuntime,
          // RFC-359 W4-D19c：回合走两个 provider 共用的中立驱动（此前 SQLite 走 legacy engine）。
          // 装配由 bootstrap 交进来——infrastructure 自己 import composition 会把 bootstrap 的
          // 职责下沉一层（RFC-328 的「装配唯一入口」守卫盯的就是这条）。
          workgroupTurns: input.workgroupTurns,
          childLaunch,
          dynamicWorkflow: input.dynamicWorkflow,
          processConcurrencyScope: input.db,
          identityAccess: input.identityAccess,
          ...(input.codeHostConnections === undefined
            ? {}
            : { codeHostConnections: input.codeHostConnections }),
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
    activity: composeLegacyTaskActivityParticipant(),
  })
}

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：进程内活跃度参与者的**唯一装配点**。
 *
 * 它包的就是 legacy 的进程内注册表（`isTaskActive` / `awaitTaskDriverReleasedSettled`），
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
