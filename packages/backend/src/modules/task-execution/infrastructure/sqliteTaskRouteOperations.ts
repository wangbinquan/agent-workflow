import {
  emptyWorkflowSyncDiff,
  isTurnEngineWorkgroupTask,
  isWorkgroupTask,
  taskExecutionKind,
  type Task,
  type WorkflowSyncPreview,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import { replaceReviewNodeReviewers } from '@/modules/collaboration/public/commands'
import { getReviewNodeReviewerConfig } from '@/modules/collaboration/public/queries'
import { applyRepairOption, listRepairOptionsForAlert } from '@/services/lifecycleRepair'
import type { MultipartLaunchDeps } from '@/services/multipartTaskStart'
import { handleMultipartTaskStart } from '@/services/multipartTaskStart'
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
import { startExecution } from '@/services/execution/executor'
import type { TaskExecutionWorkflowSnapshot } from '@/modules/resource-catalog/public/types'
import { getWorkflow } from '@/services/workflow'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { TaskRouteOperations } from '../public/taskRoutes'
import { tasks as taskRows, type LegacySqliteTaskDatabase } from './legacySqliteTransportMechanisms'

export interface SqliteTaskRouteOperationsDependencies {
  readonly db: LegacySqliteTaskDatabase
  readonly collaboration: CollaborationCommandContext
  readonly recovery: TaskRecoveryOperations
  readonly startDepsFor: (actor: Actor) => StartTaskDeps
  readonly multipart: Omit<MultipartLaunchDeps, 'db'>
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
  readonly assertWorkflowLaunchable: (workflow: TaskExecutionWorkflowSnapshot) => Promise<void>
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

function notSyncable(task: Task, reason: WorkflowSyncPreview['reason']): WorkflowSyncPreview {
  return {
    syncable: false,
    reason,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    currentVersion: task.workflowVersion,
    latestVersion: null,
    differs: false,
    invalid: false,
    invalidIssues: [],
    diff: emptyWorkflowSyncDiff(),
  }
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
      const resources = dependencies.resourceAuthorityFor(actor)
      const loaded = await resources.resources.loadAuthorized(resources, [
        { kind: 'workflow-launch', workflowId: task.workflowId },
      ])
      const snapshot = loaded[0]
      if (snapshot?.kind !== 'workflow-launch') {
        throw new Error('task-execution-resource-kind-mismatch:workflow-launch')
      }
      await dependencies.assertWorkflowLaunchable(snapshot.workflow)
      return await startExecution(
        db,
        actor,
        {
          kind: 'workflow',
          refId: task.workflowId,
          invoker: { type: 'user', launchKind: 'direct-json' },
          payload: task,
        },
        {
          ...dependencies.startDepsFor(actor),
          launchResources: resources,
          taskRecoveryOperations: dependencies.recovery,
          deferRepoPreparation: true,
        },
      )
    },
    launchMultipart: (request, actor) =>
      handleMultipartTaskStart(request, { db, ...dependencies.multipart }, actor),
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
      if (workflow === null) return notSyncable(task, 'workflow-deleted')
      if (!(await canViewResource(db, actor, 'workflow', workflow))) {
        return notSyncable(task, 'workflow-not-visible')
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
        deps: dependencies.startDepsFor(actor),
        onAlert,
        onResolved,
      })
    },
  }
  return Object.freeze(operations)
}
