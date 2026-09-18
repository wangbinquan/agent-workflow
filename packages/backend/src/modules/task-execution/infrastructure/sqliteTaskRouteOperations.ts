import type { Actor } from '@/auth/actor'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import { replaceReviewNodeReviewers } from '@/modules/collaboration/public/commands'
import { getReviewNodeReviewerConfig } from '@/modules/collaboration/public/queries'
import {
  assertManualExecutionAllowedProjection,
  assertTaskVisibleProjection,
  loadTask,
  syncWorkflow,
  launchMultipartTask,
  taskWorkflowSyncPreviewProjection,
  loadTaskProjection,
  replaceTaskMembersProjection,
  requireTaskOperatorProjection,
  taskMembersProjection,
  nodeRunEventsProjection,
  nodeRunStdoutProjection,
  taskDiffProjection,
  taskListItemsProjection,
  taskListSummariesProjection,
  taskNodeRunsProjection,
} from './taskRouteOperations'
import { retryNodeProjection } from './taskRouteOperations'
import type { AgentLaunchResourceOperations } from '../application/ports/agentLaunchResourceOperations'
import type { RepositoryPreparationRetryCommand } from '../application/ports/taskAutoResumeCommand'
import {
  createTaskRouteRepairOperations,
  type TaskRepairOperations,
  type TaskRouteRepairOperationsDependencies,
} from './taskRouteRepairOperations'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { ActiveTaskExecutionParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import { assertCanReplaySourceTask } from '@/services/taskCollab'
import { composeTaskCancellation } from '../composition/taskCancellation'
import { deleteTask } from '@/services/taskDelete'
import { Paths } from '@/util/paths'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import type { TaskRouteOperations } from '../public/taskRoutes'
import type { TaskExecutionLaunchParticipant } from './taskRouteLaunchOperations'
import type { LegacySqliteTaskDatabase } from './legacySqliteTransportMechanisms'
import { NotFoundError } from '@/util/errors'

export interface SqliteTaskRouteOperationsDependencies {
  readonly db: LegacySqliteTaskDatabase
  readonly collaboration: CollaborationCommandContext<'taskExecutionReadModels'>
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
  /**
   * RFC-359 AC-1（plan §5hn 批次二 ④）：工作流 JSON 启动的**唯一编排**，与 PostgreSQL 同一份。
   * 此前这里转 `startExecution` → `startTask`——`startExecution` 那个三分支 switch 的最后一条
   * 生产调用路。
   */
  readonly launches: TaskExecutionLaunchParticipant
  /**
   * RFC-359 AC-1（第 13 刀下）：`syncWorkflow` 的静态校验门。与 PostgreSQL 那一侧同一格
   *（那边取自 `launch.agent.resources`），共用实现只用到这一个方法，所以依赖面收成一个函数
   * ——`server.ts` 那条不装配完整 runtime 的路因此也交得起（转发到同一份
   * `composeAgentLaunchResourceOperations`）。
   */
  readonly validateHostWorkflow: AgentLaunchResourceOperations['validateHostWorkflow']
  /**
   * RFC-359 AC-1（plan §5hn 之后的盘点，第 3 刀）：列表行的 owner 身份投影。**由组合根注入**，
   * 与 PostgreSQL 那一侧同形——这层是 infrastructure，不该自己去 compose 另一个模块
   *（`rfc305-architecture-lock` 的已审消费者账本盯的正是这条边）。
   */
  readonly owners: OwnerIdentityQueries
  /**
   * RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：进程内活跃度参与者。`delete` 的
   * `task-active` 门读它，而不是模块级全局 `isTaskActive`——那个端口的文档原话就是
   * 「runtime 绝不 import legacy 注册表」，而且只有注入版本才能在两个引擎上被测。
   */
  readonly activity: ActiveTaskExecutionParticipant
  /**
   * RFC-359 AC-1（plan §5hn 之后的盘点，第 8 刀）：手动修复两个动词与 PostgreSQL 共用**同一份**
   * 实现，所以这一侧也要把那份实现的依赖面接进来。合并前这里转给
   * `services/lifecycleRepair`（`platform/persistence/sqlite/taskLifecycleRepair` 的门面），
   * 那是修复这件事的第二份实现。
   */
  readonly persistence: TaskExecutionPersistence
  readonly resumeTaskAs: (actor: Actor, taskId: string) => Promise<void>
  /**
   * RFC-359 AC-1（第 9 刀）：`retry` 与 PostgreSQL 共用**同一份**实现，这两样是它的依赖面。
   * 合并前这一侧转给 `services/task.ts` 的 `retryNode`（485 行，retry 的第二份实现）。
   */
  readonly repositoryPreparationRetry: RepositoryPreparationRetryCommand
  readonly cancelChildTaskForCascade: (childTaskId: string, parentTaskId: string) => Promise<void>
  readonly repair: Pick<
    TaskRouteRepairOperationsDependencies,
    'collaborationRuntime' | 'clarify' | 'review'
  >
  readonly appHome?: string
}

export function createSqliteTaskRouteOperations(
  dependencies: SqliteTaskRouteOperationsDependencies,
): TaskRouteOperations & Pick<TaskRepairOperations, 'automaticRepair'> {
  const { db } = dependencies
  const repairs = createTaskRouteRepairOperations({
    db,
    persistence: dependencies.persistence,
    activity: dependencies.activity,
    resumeTaskAs: dependencies.resumeTaskAs,
    collaborationRuntime: dependencies.repair.collaborationRuntime,
    clarify: dependencies.repair.clarify,
    review: dependencies.repair.review,
    appHome: dependencies.appHome ?? Paths.root,
  })
  const operations: TaskRouteOperations = {
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 3 刀）：列表三件也与 PostgreSQL 共用**同一份**。
    // 等价性由 `rfc359-w7-task-route-conformance` 的 A1–A5 作证（筛选 / 倒序 / 告警数 /
    // owner 身份 / 子任务数逐格对拍）。合并同时销掉 B6 那一格：任务行投影的严格度此前两侧不同
    //（PG `TaskSchema.parse`，SQLite 原样投出），现在统一走严格解析——枚举外的 `space_kind`
    // 这类只会由裸 SQL / 手工修复写进去的值，静默上线比响亮失败更糟（前端会落进默认分支，
    // 渲染成一个看不出错的错）。
    list: (filters) => taskListSummariesProjection(db, filters),
    listItems: (filters) => taskListItemsProjection({ db, owners: dependencies.owners }, filters),
    get: (taskId) => loadTaskProjection(db, taskId),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 4 刀）：访问门 + 成员四件与 PostgreSQL 共用**同一份**。
    // 这一侧原来就是转给 `taskCollab` 的中立实现，合并把 PG 那份内联重写退役掉；顺带统一
    // 存在性口径——**不存在即 404**，不再「取不到行就不判、靠路由随后自己 404」。
    assertVisible: (actor, taskId) => assertTaskVisibleProjection(db, actor, taskId),
    requireOperator: (actor, taskId) => requireTaskOperatorProjection(db, actor, taskId),
    assertReplayVisible: (actor, taskId) => assertCanReplaySourceTask(db, actor, taskId),
    getMembers: (actor, taskId) => taskMembersProjection(db, actor, taskId),
    replaceMembers: (actor, taskId, body) => replaceTaskMembersProjection(db, actor, taskId, body),
    getReviewers: (actor, taskId) =>
      getReviewNodeReviewerConfig(dependencies.collaboration, { actor, taskId }),
    replaceReviewers: (actor, taskId, body) =>
      replaceReviewNodeReviewers(dependencies.collaboration, { actor, taskId, body }),
    async launchWorkflow(actor, task) {
      // RFC-359 AC-1（plan §5hn 批次二 ④）：与 PostgreSQL 共用同一份编排。参与者自己做
      // 冻结快照（`loadAuthorized` 里含 `assertNotBuiltin`）、版本围栏、带候选的静态校验
      // 与 payload 解析，终端是根启动内核——所以这里不再需要路由自己那道
      // `assertWorkflowLaunchable`（它做的正是参与者已经做过的那次静态校验）。
      // RFC-287 G7：JSON body 启动延后仓库准备，这一格只有路由自己知道（隔壁 multipart 不能延后）。
      return await dependencies.launches.launch({
        actor,
        target: { kind: 'workflow', refId: task.workflowId, payload: task },
        invoker: { type: 'user', launchKind: 'direct-json' },
        resources: dependencies.resourceAuthorityFor(actor),
        deferRepoPreparation: true,
      })
    },
    // RFC-359 AC-1（plan §5hn 批次二 ⑥）：multipart 启动与 PostgreSQL 共用**同一条编排**。
    // 此前这里转 `services/multipartTaskStart.ts` → `startExecution` → `startTaskImpl`，
    // 那是 `startExecution` 在生产上的**最后一条**调用路。
    launchMultipart: (request, actor) =>
      launchMultipartTask(
        {
          db,
          launches: dependencies.launches,
          resourceAuthorityFor: dependencies.resourceAuthorityFor,
        },
        request,
        actor,
      ),
    // RFC-359 AC-1（第 11 刀）：`cancel` 与 PostgreSQL 共用**同一份**实现
    // （`cancelTaskProjection`），装配走模块自己的 `composeTaskCancellation`。
    // 回读那三行与 PG 路由逐字同形——共用实现返回 void，路由契约要的是任务行。
    async cancel(taskId) {
      await composeTaskCancellation(db).cancel(taskId)
      const task = await loadTask(db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：`delete` 与 PostgreSQL 共用**同一份**
    //（PG 那侧 184 行的内联实现已删除）。合并同时统一了前置门次序——`task-internal`
    // 先于 `task-active`，先报永久性的主因再报暂时性的次因。
    delete: (taskId) => deleteTask(db, taskId, { activity: dependencies.activity }),
    // RFC-359 AC-1（第 10 刀）：`resume` 与 PostgreSQL 共用**同一份**实现。
    // 这一层只剩「交给注入的复活端口，再把任务重读一遍」——与 PG 那一侧的路由壳逐字同形
    //（复活本身返回 void，响应体必须重读才是真状态）。
    // 等价性由 `rfc359-w10-resume-admission-parity` 的九格对拍作证。
    async resume({ actor, taskId }) {
      await dependencies.resumeTaskAs(actor, taskId)
      const task = await loadTask(db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    // RFC-359 AC-1（第 9 刀）：`retry` 与 PostgreSQL 共用**同一份**实现。
    // 等价性由 `rfc359-w9-retry-rollback-parity` 的 10 格对拍作证（回滚基线升级、级联形状、
    // 不级联、帧继承、任务收尾、归属门早于 CAS、kind 矩阵、wrapper 复活豁免、终态子任务），
    // 每格都有变异实证；合并前的对拍还照出一处 PG 侧真缺陷并已修。
    retry: (input) =>
      retryNodeProjection(
        {
          db,
          persistence: dependencies.persistence,
          activity: dependencies.activity,
          repositoryPreparationRetry: dependencies.repositoryPreparationRetry,
          resumeTaskAs: dependencies.resumeTaskAs,
          cancelChildTaskForCascade: dependencies.cancelChildTaskForCascade,
        },
        input,
      ),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 1 刀）：node-runs 投影与 PostgreSQL 共用**同一份**。
    // 等价性由 `rfc359-w5hn-task-read-route-provider-parity` 作证（同一批
    // `node_runs` / `doc_versions` / `clarify_rounds` 播种下两侧响应体逐字相同，
    // 单侧变异当场红），合并前后行为不变。
    nodeRuns: (taskId) => taskNodeRunsProjection({ db }, taskId),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 2 刀）：纯读另外三件也与 PostgreSQL 共用**同一份**。
    // 等价性由 `rfc359-w5hn-task-read-route-provider-parity` 作证（同一批 `node_run_events`、
    // 同一棵真 git 工作树下两侧响应体逐字相同，单侧变异当场红）。合并同时销掉一笔账：
    // 单仓 410 的两句话文案此前只有 SQLite 有，PostgreSQL 压成一句泛化的 `is unavailable`。
    diff: (taskId) => taskDiffProjection({ db }, taskId),
    stdout: (taskId, nodeRunId) => nodeRunStdoutProjection({ db }, taskId, nodeRunId),
    events: (taskId, nodeRunId, options) =>
      nodeRunEventsProjection({ db }, taskId, nodeRunId, { ...options }),
    // RFC-359 AC-1（第 13 刀）：手动执行门与 PostgreSQL 共用**同一份**实现。
    // 此前这一侧是本地 27 行（`getTask` + bun:sqlite 同步读取工作组配置 + `getWorkflow` 判内置），
    // 合并取强的那一半——多出来的那道门是「工作流现在还在不在、我还看不看得见」
    //（原 `rfc359-w7` 的 B3 记的就是这条差异）。
    assertManualExecutionAllowed: (actor, taskId) =>
      assertManualExecutionAllowedProjection(
        { db, resourceAuthorityFor: dependencies.resourceAuthorityFor },
        actor,
        taskId,
      ),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 6 刀）：预览与 PostgreSQL 共用**同一份**。
    // 授权路径就是这一侧原来的**可见性**；合并同时抬进 PG 那侧更强的两道门——
    // 非工作流任务不给同步横幅，以及进程内仍在跑时报 `task-active`
    //（此前这一侧只看状态 + 工作树，刚重启守护进程的任务会预览成可同步、点下去 409）。
    workflowSyncPreview: (actor, taskId) =>
      taskWorkflowSyncPreviewProjection(
        {
          db,
          activity: dependencies.activity,
          resourceAuthorityFor: dependencies.resourceAuthorityFor,
        },
        actor,
        taskId,
      ),
    // RFC-359 AC-1（第 13 刀下）：`syncWorkflow` 与 PostgreSQL 共用**同一份**实现。
    // 合并之前这一侧转给 `services/task.ts` 的 `syncTaskWorkflow`（160 行，sync 的第二份
    // 实现，终端是 `resumeKick` 的一段式准入）；共用那份走两段式交棒（准入 CAS 落
    // `interrupted` + 打 `continuationHandoff` 标记，随后才交给复活端口），并且多两样
    // SQLite 这边一直没有的东西：回滚基线的**跨行零副作用预检**（任一行基线被 GC 回收时
    // 干净失败，而不是推进 interrupted 之后在半截回滚里发现），以及把 canceled 写节点的
    // 回滚交给 `selectSyncRollbackTargets`（failed / interrupted 两档由紧随其后的复活
    // 连同租约围栏一并处理，不重复动工作树）。
    // 七道前置门（`assertTaskWorkflowSyncable`）本来就是共用的，现在由共用实现自己调。
    syncWorkflow: (input) =>
      syncWorkflow(
        {
          db,
          persistence: dependencies.persistence,
          activity: dependencies.activity,
          resourceAuthorityFor: dependencies.resourceAuthorityFor,
          validateHostWorkflow: dependencies.validateHostWorkflow,
          resumeTaskAs: dependencies.resumeTaskAs,
        },
        input,
      ),
    // RFC-359 AC-1（第 8 刀）：手动修复两个动词直接交给共用的那一份实现。
    repairOptions: (input) => repairs.repairOptions(input),
    applyRepair: (input) => repairs.applyRepair(input),
  }
  return Object.freeze({ ...operations, automaticRepair: repairs.automaticRepair })
}
