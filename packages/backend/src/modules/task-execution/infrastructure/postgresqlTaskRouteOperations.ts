// RFC-359 AC-1（命名债收尾 §5hj）—— `/api/tasks` 这条经典路由面的 **PostgreSQL 绑定**。
//
// 实现本身已经拆到同目录的 `taskRouteOperations.ts`（那 22 个导出里 15 个被 SQLite 侧直接
// 消费，它早就是共用的那一份）。留在这里的只有**装配**：PG 专属的依赖面（`db` 是
// `PostgresqlDatabaseClient`）与把它绑成 `TaskRouteOperations` 的工厂。
// 与 `sqliteTaskRouteOperations.ts` 形状对称：一份实现，两个绑定。

import type { TaskRouteOperations } from '../public/taskRoutes'
import { createTaskExecutionLaunchParticipant } from './taskRouteLaunchOperations'

import {
  assertManualExecutionAllowedProjection,
  assertTaskVisibleProjection,
  launchMultipartTask,
  listItems,
  loadTask,
  nodeRunEventsProjection,
  nodeRunStdoutProjection,
  replaceTaskMembersProjection,
  requireTaskOperatorProjection,
  retryNodeProjection,
  taskDiffProjection,
  taskListSummariesProjection,
  taskMembersProjection,
  taskNodeRunsProjection,
  taskWorkflowSyncPreviewProjection,
  syncWorkflow,
} from './taskRouteOperations'
import { createTaskRouteRepairOperations } from './taskRouteRepairOperations'
import type { TaskRepairOperations } from './taskRouteRepairOperations'

import { replaceReviewNodeReviewers } from '@/modules/collaboration/public/commands'

import { getReviewNodeReviewerConfig } from '@/modules/collaboration/public/queries'

import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { assertCanReplaySourceTask } from '@/services/taskCollab'
import { deleteTask } from '@/services/taskDelete'
import { NotFoundError } from '@/util/errors'
import { Paths } from '@/util/paths'
import type { TaskRouteOperationsDependencies } from './taskRouteOperations'

/** PG 绑定的依赖面：与中立那份逐格相同，只把库句柄收窄成 PG 客户端。 */
export interface PostgresqlTaskRouteOperationsDependencies extends Omit<
  TaskRouteOperationsDependencies,
  'db'
> {
  readonly db: PostgresqlDatabaseClient
}

// 两个调用点：一个传客户端本身，一个传事务句柄。RFC-359 W5-T18 之后事务句柄是中立的
// `DatabaseTransaction`，客户端仍是 PG 客户端——取二者共同的读面（`ProviderNeutralDatabase`
// 是两个 provider 客户端的公共基类型，见 `db/query.ts`）。

/** Complete PostgreSQL binding for the classic `/api/tasks` surface. */
export function createPostgresqlTaskRouteOperations(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
): TaskRouteOperations & Pick<TaskRepairOperations, 'automaticRepair'> {
  const launches = createTaskExecutionLaunchParticipant({
    db: dependencies.db,
    ...dependencies.launch,
  })
  const repairs = createTaskRouteRepairOperations({
    db: dependencies.db,
    persistence: dependencies.persistence,
    activity: dependencies.activity,
    resumeTaskAs: async (actor, taskId) => {
      await dependencies.children.resume(
        { taskId, runtime: dependencies.resumeRuntimeFor(actor, taskId) },
        dependencies.topology,
      )
    },
    collaborationRuntime: dependencies.repair.collaborationRuntime,
    clarify: dependencies.repair.clarify,
    review: dependencies.repair.review,
    appHome: dependencies.appHome ?? Paths.root,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.id === undefined ? {} : { id: dependencies.id }),
  })

  const operations: TaskRouteOperations = {
    list: (filters) => taskListSummariesProjection(dependencies.db, filters),
    listItems: (filters) => listItems(dependencies, filters),
    get: (taskId) => loadTask(dependencies.db, taskId),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 4 刀）：访问门 + 成员四件与 SQLite 共用**同一份**。
    // 取的是 `taskCollab` 那一份（原 SQLite 侧转发的目标）——它严格更全：RFC-324 观察者只读
    // 文案、与评审写同一把任务 FIFO 锁、锁内重读任务行。存在性口径统一成「不存在即 404」。
    assertVisible: (actor, taskId) => assertTaskVisibleProjection(dependencies.db, actor, taskId),
    requireOperator: (actor, taskId) =>
      requireTaskOperatorProjection(dependencies.db, actor, taskId),
    assertReplayVisible: (actor, sourceTaskId) =>
      assertCanReplaySourceTask(dependencies.db, actor, sourceTaskId),
    getMembers: (actor, taskId) => taskMembersProjection(dependencies.db, actor, taskId),
    replaceMembers: (actor, taskId, body) =>
      replaceTaskMembersProjection(dependencies.db, actor, taskId, body),
    getReviewers: (actor, taskId) =>
      getReviewNodeReviewerConfig(dependencies.collaboration, { actor, taskId }),
    replaceReviewers: (actor, taskId, body) =>
      replaceReviewNodeReviewers(dependencies.collaboration, { actor, taskId, body }),
    async launchWorkflow(actor, task) {
      const authority = dependencies.launch.resourceAuthorityFor(actor)
      return await launches.launch({
        actor,
        target: { kind: 'workflow', refId: task.workflowId, payload: task },
        invoker: { type: 'user', launchKind: 'direct-json' },
        resources: authority,
        // RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）：**JSON body 启动延后仓库准备**。
        // 这一格只有路由自己知道——隔壁 `launchMultipart` 走的是同一台内核，但它必须
        // 保持预物化（上传物要写进真工作树），所以判据不能放在内核里按 invoker 猜。
        deferRepoPreparation: true,
      })
    },
    launchMultipart: (request, actor) =>
      launchMultipartTask(
        {
          db: dependencies.db,
          launches: dependencies.launches,
          resourceAuthorityFor: dependencies.launch.resourceAuthorityFor,
        },
        request,
        actor,
      ),
    async cancel(taskId) {
      await dependencies.children.cancel({ taskId, cause: { kind: 'user' } })
      const task = await loadTask(dependencies.db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：`delete` 与 SQLite 共用**同一份**
    //（`services/taskDelete.ts`，上一提刚把它从 bun:sqlite 专有句柄中立化）。本文件里那份
    // 184 行的内联实现随之退役；提交后的 WS 广播由共用实现自己做，`deletionEvents`
    // 这个转发端口与它在组合根里的绑定一并删除（与第 4 刀的 `membershipEvents` 同形）。
    delete: (taskId) => deleteTask(dependencies.db, taskId, { activity: dependencies.activity }),
    async resume({ actor, taskId }) {
      await dependencies.children.resume(
        { taskId, runtime: dependencies.resumeRuntimeFor(actor, taskId) },
        dependencies.topology,
      )
      const task = await loadTask(dependencies.db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    retry: (input) =>
      retryNodeProjection(
        {
          ...dependencies,
          resumeTaskAs: async (actor, taskId) => {
            await dependencies.children.resume(
              { taskId, runtime: dependencies.resumeRuntimeFor(actor, taskId) },
              dependencies.topology,
            )
          },
          cancelChildTaskForCascade: async (childTaskId, parentTaskId) => {
            await dependencies.children.cancel({
              taskId: childTaskId,
              cause: { kind: 'parent-cascade', parentTaskId },
            })
          },
        },
        input,
      ),
    nodeRuns: (taskId) => taskNodeRunsProjection(dependencies, taskId),
    diff: (taskId) => taskDiffProjection(dependencies, taskId),
    stdout: (taskId, nodeRunId) => nodeRunStdoutProjection(dependencies, taskId, nodeRunId),
    events: (taskId, nodeRunId, options) =>
      nodeRunEventsProjection(dependencies, taskId, nodeRunId, options),
    // RFC-359 AC-1（第 13 刀）：手动执行门与 SQLite 共用**同一份**实现。
    // 此前这段内联在这里，SQLite 那侧另有一份 27 行的本地版本（带 bun:sqlite 同步读）。
    assertManualExecutionAllowed: (actor, taskId) =>
      assertManualExecutionAllowedProjection(
        { db: dependencies.db, resourceAuthorityFor: dependencies.launch.resourceAuthorityFor },
        actor,
        taskId,
      ),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 6 刀）：预览与 SQLite 共用**同一份**。
    // 授权路径统一成**可见性**（原 SQLite 那一档）——预览回答的是「同步会发生什么」，
    // 不是「我现在能不能启动它」；本文件原来那份走可启动性，于是不得不给内置工作流补一道
    // 前置门去绕，换成可见性之后那道门自然不需要。
    workflowSyncPreview: (actor, taskId) =>
      taskWorkflowSyncPreviewProjection(
        {
          db: dependencies.db,
          activity: dependencies.activity,
          resourceAuthorityFor: dependencies.launch.resourceAuthorityFor,
        },
        actor,
        taskId,
      ),
    syncWorkflow: (input) => syncWorkflow(dependencies, input),
    repairOptions: (input) => repairs.repairOptions(input),
    applyRepair: (input) => repairs.applyRepair(input),
  }
  return Object.freeze({ ...operations, automaticRepair: repairs.automaticRepair })
}
