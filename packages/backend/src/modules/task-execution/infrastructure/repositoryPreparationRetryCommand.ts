// RFC-387: validate the persisted preparation attempt, atomically admit, then drive in the background.
import { createNodeRunQueries } from './nodeRunQueries'
import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { decodeRequestedSource } from './taskRepositorySurface'
import { taskRequestedSourceColumns, taskWorkspaceUnboundSql } from './taskRepositorySql'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  REPO_PREP_NODE_ID,
  StartTaskSchema,
  type StartTask,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import type { TaskDriveCoordinator } from '../application/drive/taskDriveTypes'
import type {
  RepositoryPreparationRetryAuthorization,
  RepositoryPreparationRetryCommand,
} from '../application/ports/taskAutoResumeCommand'
import { submitTaskContinuation } from './taskContinuationAdmission'
import { withSerializableTaskExecution } from './taskLifecycleTransaction'
import { assertTaskOwnerlessTx } from './ownedTaskExecution'
import { appendTaskLifecycleTransitionCommittedEvent } from './taskLifecycleCommittedEvents'

const RETRYABLE_TASK_STATUSES = ['failed', 'canceled', 'interrupted'] as const
const RETRYABLE_PREP_STATUSES = ['failed', 'interrupted'] as const

type TaskRow = Pick<
  PersistenceTables['tasks']['$inferSelect'],
  | 'id'
  | 'name'
  | 'workflowId'
  | 'status'
  | 'inputs'
  | 'maxDurationMs'
  | 'maxTotalTokens'
  | 'finishedAt'
  | 'errorSummary'
  | 'errorMessage'
  | 'failedNodeId'
  | 'gitUserName'
  | 'gitUserEmail'
  | 'workingBranch'
  | 'autoCommitPush'
  | 'cachedRepoId'
  | 'repoGroupId'
  | 'worktreePath'
  | 'baseBranch'
  | 'lifecycleEventRevision'
  | 'workspacePruningAt'
  | 'workspacePrunedAt'
  | 'sourceTerminationFence'
>
type PrepRow = Pick<PersistenceTables['nodeRuns']['$inferSelect'], 'id' | 'retryIndex' | 'status'>

export interface RepositoryPreparationRetryDependencies {
  readonly db: PersistenceDb
  readonly coordinator: TaskDriveCoordinator
  readonly isTaskActive: (taskId: string) => boolean
  readonly awaitTaskSettled: (taskId: string) => Promise<void>
  readonly id?: () => string
  readonly now?: () => number
}

function parseInputs(raw: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

function retryPreparationInput(task: TaskRow): StartTask {
  const requestedSource = decodeRequestedSource(task)
  const source =
    requestedSource.repoGroupId !== null && requestedSource.repoGroupId.length > 0
      ? { repoGroupId: requestedSource.repoGroupId }
      : requestedSource.cachedRepoId !== null && requestedSource.cachedRepoId.length > 0
        ? {
            cachedRepoId: requestedSource.cachedRepoId,
            ...(requestedSource.requestedRef === '' ? {} : { ref: requestedSource.requestedRef }),
          }
        : null
  if (source === null) {
    throw new ConflictError(
      'repo-prep-source-unavailable',
      `task '${task.id}' has no persisted repository preparation source`,
    )
  }
  return StartTaskSchema.parse({
    workflowId: task.workflowId,
    name: task.name,
    inputs: parseInputs(task.inputs),
    ...source,
    ...(task.workingBranch === null ? {} : { workingBranch: task.workingBranch }),
    ...(task.autoCommitPush ? { autoCommitPush: true } : {}),
    ...(task.maxDurationMs === null ? {} : { maxDurationMs: task.maxDurationMs }),
    ...(task.maxTotalTokens === null ? {} : { maxTotalTokens: task.maxTotalTokens }),
  })
}

function retryGitIdentity(task: TaskRow): Readonly<{ name: string; email: string }> | null {
  if (task.gitUserName === null && task.gitUserEmail === null) return null
  if (task.gitUserName === null || task.gitUserEmail === null) {
    throw new ConflictError(
      'task-git-identity-incomplete',
      `task '${task.id}' has an incomplete frozen Git identity`,
    )
  }
  return { name: task.gitUserName, email: task.gitUserEmail }
}

async function loadRetrySnapshot(
  dependencies: RepositoryPreparationRetryDependencies,
  taskId: string,
): Promise<{ readonly task: TaskRow; readonly prep: PrepRow }> {
  const { tasks } = tablesOf(dependencies.db)
  const rows = await dependencies.db
    .select({
      id: tasks.id,
      name: tasks.name,
      workflowId: tasks.workflowId,
      status: tasks.status,
      inputs: tasks.inputs,
      maxDurationMs: tasks.maxDurationMs,
      maxTotalTokens: tasks.maxTotalTokens,
      finishedAt: tasks.finishedAt,
      errorSummary: tasks.errorSummary,
      errorMessage: tasks.errorMessage,
      failedNodeId: tasks.failedNodeId,
      gitUserName: tasks.gitUserName,
      gitUserEmail: tasks.gitUserEmail,
      workingBranch: tasks.workingBranch,
      autoCommitPush: tasks.autoCommitPush,
      ...taskRequestedSourceColumns(dependencies.db),
      worktreePath: tasks.worktreePath,
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePrunedAt: tasks.workspacePrunedAt,
      sourceTerminationFence: tasks.sourceTerminationFence,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const task = rows[0]
  if (task === undefined) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  await dependencies.awaitTaskSettled(taskId)
  if (dependencies.isTaskActive(taskId)) {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' has an active scheduler attached`,
    )
  }
  if (!RETRYABLE_TASK_STATUSES.includes(task.status as (typeof RETRYABLE_TASK_STATUSES)[number])) {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' is ${task.status}; repository preparation cannot be retried`,
    )
  }
  if (!isTaskWorkspaceUnbound(task.worktreePath)) {
    throw new ConflictError(
      'repo-prep-already-complete',
      `task '${taskId}' already has a materialized workspace`,
    )
  }
  if (task.workspacePrunedAt !== null) {
    throw new DomainError('workspace-pruned', `task '${taskId}' workspace was reclaimed`, 410)
  }
  if (task.workspacePruningAt !== null) {
    throw new ConflictError('workspace-pruning', `task '${taskId}' workspace is being reclaimed`)
  }
  if (task.sourceTerminationFence !== null) {
    throw new ConflictError(
      task.sourceTerminationFence === 'closed'
        ? 'task-source-terminal-closed'
        : 'task-source-terminal-merged',
      `task '${taskId}' is fenced by its source termination`,
    )
  }
  const prep =
    (
      await createNodeRunQueries(dependencies.db).listFields(
        {
          taskId,
          nodeId: REPO_PREP_NODE_ID,
          order: 'retry-desc',
          limit: 1,
        },
        ['id', 'status', 'retryIndex'],
      )
    )[0] ?? null
  if (prep === null) {
    throw new ConflictError(
      'repo-prep-run-missing',
      `task '${taskId}' has no repository-preparation attempt to retry`,
    )
  }
  if (!RETRYABLE_PREP_STATUSES.includes(prep.status as (typeof RETRYABLE_PREP_STATUSES)[number])) {
    throw new ConflictError(
      'repo-prep-not-retryable',
      `repository preparation for task '${taskId}' is '${prep.status}'`,
    )
  }
  retryPreparationInput(task)
  retryGitIdentity(task)
  return { task, prep }
}

async function admitRetry(
  dependencies: RepositoryPreparationRetryDependencies,
  snapshot: { readonly task: TaskRow; readonly prep: PrepRow },
  authorization: RepositoryPreparationRetryAuthorization | undefined,
): Promise<string> {
  const now = dependencies.now?.() ?? Date.now()
  const nextId = dependencies.id ?? ulid
  const operationRef = `repo-prep-retry:${snapshot.task.id}:${nextId()}`
  const intentId = nextId()
  const committed = await withSerializableTaskExecution(dependencies.db, async (tx) => {
    await assertTaskOwnerlessTx(tx, snapshot.task.id)
    const { tasks } = tablesOf(tx)
    const admittedRows = await tx
      .update(tasks)
      .set({
        status: 'pending',
        finishedAt: null,
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, snapshot.task.id),
          eq(tasks.status, snapshot.task.status),
          eq(tasks.lifecycleEventRevision, snapshot.task.lifecycleEventRevision),
          taskWorkspaceUnboundSql(tasks.worktreePath),
          isNull(tasks.workspacePruningAt),
          isNull(tasks.workspacePrunedAt),
          isNull(tasks.sourceTerminationFence),
        ),
      )
      .returning({ revision: tasks.lifecycleEventRevision })
    const admitted = admittedRows[0]
    if (admitted === undefined) {
      throw new ConflictError(
        'task-still-running',
        `task '${snapshot.task.id}' changed during repository preparation`,
      )
    }
    // 演员发起的重试必须以 `rest` + actorUserId 提交，否则 `mayAuthorizeReplay` 不授权重放，
    // 血缘上留着的 `requires-actor` 重放决定会把这次重试判成
    // `task-execution-outcome-unknown`——而它本身就是那条被要求使用的手动命令（e2e TASK-27）。
    // 无授权时保持 `auto`：那是 boot 自动恢复那条路。
    await submitTaskContinuation(tx, {
      taskId: snapshot.task.id,
      intentId,
      kind: 'retry-repository-preparation',
      ...(authorization === undefined
        ? { source: 'auto' as const, actorUserId: null }
        : { source: 'rest' as const, actorUserId: authorization.actorUserId }),
      payload: { v: 1, phase: 'repository-preparation' },
      now,
      advanceOperationGeneration: true,
    })
    const event = await appendTaskLifecycleTransitionCommittedEvent(tx, {
      taskId: snapshot.task.id,
      lifecycleRevision: admitted.revision,
      previousStatus: snapshot.task.status as TaskStatus,
      status: 'pending',
      errorSummary: null,
      occurredAt: now,
      identity: { operationRef, eventGroupId: operationRef, eventGroupOrdinal: 0 },
    })
    return { intentId, events: event === null ? [] : [event] }
  })
  await publishCommittedEventsAfterCommit(committed.events)
  return committed.intentId
}

/** No filesystem work or process-local in-flight set belongs in admission. */
export function createRepositoryPreparationRetryCommand(
  dependencies: RepositoryPreparationRetryDependencies,
): RepositoryPreparationRetryCommand {
  return Object.freeze({
    async retry(
      taskId: string,
      authorization?: RepositoryPreparationRetryAuthorization,
    ): Promise<void> {
      const snapshot = await loadRetrySnapshot(dependencies, taskId)
      const intentId = await admitRetry(dependencies, snapshot, authorization)
      await dependencies.coordinator.submit({ taskId, intentId, completionMode: 'background' })
    },
  })
}
