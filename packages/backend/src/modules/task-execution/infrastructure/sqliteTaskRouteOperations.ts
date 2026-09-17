import {
  isTurnEngineWorkgroupTask,
  isWorkgroupTask,
  taskExecutionKind,
  type Task,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import { replaceReviewNodeReviewers } from '@/modules/collaboration/public/commands'
import { getReviewNodeReviewerConfig } from '@/modules/collaboration/public/queries'
import { applyRepairOption, listRepairOptionsForAlert } from '@/services/lifecycleRepair'
import { launchMultipartTask } from './postgresqlTaskRouteOperations'
import {
  assertCanReplaySourceTask,
  canViewTask,
  getTaskMembers,
  requireTaskOperator,
  updateTaskMembers,
} from '@/services/taskCollab'
import { canViewResource } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import {
  cancelTask,
  computeWorkflowSyncPreview,
  getNodeRunEvents,
  getNodeRunStdout,
  getTask,
  getTaskDiff,
  getTaskNodeRuns,
  listTaskItems,
  listTasks,
  resumeTask,
  retryNode,
  syncTaskWorkflow,
  type StartTaskDeps,
} from '@/services/task'
import { deleteTask } from '@/services/taskDelete'
import { getWorkflow } from '@/services/workflow'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { TaskRouteOperations } from '../public/taskRoutes'
import type { PostgresqlTaskExecutionLaunchParticipant } from './postgresqlTaskRouteLaunchOperations'
import { tasks as taskRows, type LegacySqliteTaskDatabase } from './legacySqliteTransportMechanisms'
import { notSyncableWorkflowPreview } from '../domain/workflowSyncPreview'

export interface SqliteTaskRouteOperationsDependencies {
  readonly db: LegacySqliteTaskDatabase
  readonly collaboration: CollaborationCommandContext<'taskExecutionReadModels'>
  readonly recovery: TaskRecoveryOperations
  readonly startDepsFor: (actor: Actor) => StartTaskDeps
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
  /**
   * RFC-359 AC-1（plan §5hn 批次二 ④）：工作流 JSON 启动的**唯一编排**，与 PostgreSQL 同一份。
   * 此前这里转 `startExecution` → `startTask`——`startExecution` 那个三分支 switch 的最后一条
   * 生产调用路。
   */
  readonly launches: PostgresqlTaskExecutionLaunchParticipant
  readonly appHome?: string
}

async function requiredTask(db: LegacySqliteTaskDatabase, taskId: string): Promise<Task> {
  const task = await getTask(db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  return task
}

async function taskAccessRow(db: LegacySqliteTaskDatabase, taskId: string) {
  return db
    .select({ id: taskRows.id, ownerUserId: taskRows.ownerUserId })
    .from(taskRows)
    .where(eq(taskRows.id, taskId))
    .limit(1)
    .all()[0]
}

async function assertManualExecutionAllowed(
  db: LegacySqliteTaskDatabase,
  taskId: string,
): Promise<void> {
  const task = await getTask(db, taskId)
  if (task === null) return
  const kind = taskExecutionKind(task)
  if (kind === 'agent' || kind === 'code-round') return
  if (isWorkgroupTask(task)) {
    const row = db
      .select({ workgroupConfigJson: taskRows.workgroupConfigJson })
      .from(taskRows)
      .where(eq(taskRows.id, taskId))
      .limit(1)
      .all()[0]
    if (
      !isTurnEngineWorkgroupTask({
        workgroupId: task.workgroupId,
        workgroupConfigJson: row?.workgroupConfigJson ?? null,
      })
    ) {
      return
    }
  }
  const workflow = await getWorkflow(db, task.workflowId)
  if (workflow !== null) assertNotBuiltin('workflow', workflow)
}

async function assertTaskSyncable(db: LegacySqliteTaskDatabase, taskId: string): Promise<Task> {
  const task = await requiredTask(db, taskId)
  if (taskExecutionKind(task) !== 'workflow') {
    throw new ValidationError(
      'task-host-sync-unsupported',
      'agent/workgroup host tasks run a synthesized snapshot — there is no workflow to sync from',
    )
  }
  const workflow = await getWorkflow(db, task.workflowId)
  if (workflow !== null) assertNotBuiltin('workflow', workflow)
  return task
}

export function createSqliteTaskRouteOperations(
  dependencies: SqliteTaskRouteOperationsDependencies,
): TaskRouteOperations {
  const { db } = dependencies
  const operations: TaskRouteOperations = {
    list: (filters) => listTasks(db, filters),
    listItems: (filters) => listTaskItems(db, filters),
    get: (taskId) => getTask(db, taskId),
    async assertVisible(actor, taskId) {
      if (actor.permissions.has('tasks:read:all')) return
      const task = await taskAccessRow(db, taskId)
      if (task !== undefined && !(await canViewTask(db, actor, task))) {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
    },
    async requireOperator(actor, taskId) {
      const task = await taskAccessRow(db, taskId)
      if (task !== undefined) await requireTaskOperator(db, actor, task)
    },
    assertReplayVisible: (actor, taskId) => assertCanReplaySourceTask(db, actor, taskId),
    async getMembers(actor, taskId) {
      const task = await taskAccessRow(db, taskId)
      if (task === undefined) {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
      return await getTaskMembers(db, actor, task)
    },
    async replaceMembers(actor, taskId, body) {
      const task = await taskAccessRow(db, taskId)
      if (task === undefined) {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
      return await updateTaskMembers(db, actor, task, body)
    },
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
    cancel: (taskId) => cancelTask(db, taskId),
    delete: (taskId) => deleteTask(db, taskId),
    async resume({ actor, taskId }) {
      return await resumeTask(db, taskId, {
        ...dependencies.startDepsFor(actor),
        taskRecoveryOperations: dependencies.recovery,
        actorUserId: actor.user.id,
      })
    },
    async retry({ actor, taskId, nodeRunId, cascade }) {
      return await retryNode(db, taskId, nodeRunId, {
        cascade,
        deps: {
          ...dependencies.startDepsFor(actor),
          taskRecoveryOperations: dependencies.recovery,
          actorUserId: actor.user.id,
        },
      })
    },
    nodeRuns: (taskId) => getTaskNodeRuns(db, taskId),
    diff: (taskId) => getTaskDiff(db, taskId),
    stdout: (taskId, nodeRunId) => getNodeRunStdout(db, taskId, nodeRunId),
    events: (taskId, nodeRunId, options) => getNodeRunEvents(db, taskId, nodeRunId, { ...options }),
    assertManualExecutionAllowed: (_actor, taskId) => assertManualExecutionAllowed(db, taskId),
    async workflowSyncPreview(actor, taskId) {
      const task = await requiredTask(db, taskId)
      const workflow = await getWorkflow(db, task.workflowId)
      if (workflow === null) return notSyncableWorkflowPreview(task, 'workflow-deleted')
      if (!(await canViewResource(db, actor, 'workflow', workflow))) {
        return notSyncableWorkflowPreview(task, 'workflow-not-visible')
      }
      return await computeWorkflowSyncPreview(
        db,
        task,
        workflow,
        dependencies.resourceAuthorityFor(actor),
      )
    },
    async syncWorkflow({ actor, taskId, expectedVersion }) {
      const task = await assertTaskSyncable(db, taskId)
      const workflow = await getWorkflow(db, task.workflowId)
      if (workflow === null) {
        throw new NotFoundError(
          'workflow-deleted',
          `workflow '${task.workflowId}' no longer exists`,
        )
      }
      if (!(await canViewResource(db, actor, 'workflow', workflow))) {
        throw new NotFoundError('workflow-not-visible', `workflow '${task.workflowId}' not found`)
      }
      return await syncTaskWorkflow(db, taskId, {
        ...dependencies.startDepsFor(actor),
        taskRecoveryOperations: dependencies.recovery,
        expectedVersion,
        launchResources: dependencies.resourceAuthorityFor(actor),
        actorUserId: actor.user.id,
      })
    },
    async repairOptions({ actor, taskId, alertId }) {
      return await listRepairOptionsForAlert({
        db,
        taskId,
        alertId,
        actorUserId: actor.user.id,
        appHome: dependencies.appHome ?? Paths.root,
        deps: {
          ...dependencies.startDepsFor(actor),
          taskRecoveryOperations: dependencies.recovery,
        },
      })
    },
    async applyRepair({ actor, taskId, alertId, optionId, onAlert, onResolved }) {
      return await applyRepairOption({
        db,
        operations: dependencies.recovery,
        taskId,
        alertId,
        optionId,
        actorUserId: actor.user.id,
        appHome: dependencies.appHome ?? Paths.root,
        deps: {
          ...dependencies.startDepsFor(actor),
          taskRecoveryOperations: dependencies.recovery,
        },
        onAlert,
        onResolved,
      })
    },
  }
  return Object.freeze(operations)
}
