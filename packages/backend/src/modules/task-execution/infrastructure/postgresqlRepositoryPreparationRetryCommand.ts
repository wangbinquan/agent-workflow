import {
  REPO_PREP_NODE_ID,
  StartTaskSchema,
  type StartTask,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { nodeRuns, taskRepos, taskSpaceNodes, tasks } from '@/db/schema'
import { composePostgresqlRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import { runGit, withWorktreeRegistryLock } from '@/util/git'
import type { TaskDriveCoordinator } from '../application/drive/taskDriveTypes'
import { nextRetryIndex } from '../application/nextRetryIndex'
import type { RepositoryPreparationRetryCommand } from '../application/ports/taskAutoResumeCommand'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { createPostgresqlNodeRunMintParticipantInTx } from './postgresqlNodeRunMintParticipant'
import { submitPostgresqlTaskContinuationTx } from './postgresqlTaskExecutionIntentPersistence'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  assertPostgresqlTaskOwnerlessTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'
import type {
  PostgresqlTaskRoutePreparedWorkspace,
  PostgresqlTaskRouteWorkspaceRepository,
} from './postgresqlTaskRouteLaunchOperations'
import type { PostgresqlTaskWorkspaceMaterializer } from './postgresqlTaskRouteWorkspaceParticipant'

const RETRYABLE_TASK_STATUSES = ['failed', 'canceled', 'interrupted'] as const
const RETRYABLE_PREP_STATUSES = ['failed', 'interrupted'] as const

type TaskRow = Pick<
  typeof tasks.$inferSelect,
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
type PrepRow = Pick<typeof nodeRuns.$inferSelect, 'id' | 'retryIndex' | 'status'>

export interface PostgresqlRepositoryPreparationRetryDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly workspace: PostgresqlTaskWorkspaceMaterializer
  readonly coordinator: TaskDriveCoordinator
  readonly isTaskActive: (taskId: string) => boolean
  readonly log: TaskExecutionTopologyLogger
  readonly id?: () => string
  readonly now?: () => number
}

function diagnosticText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details = (error as { readonly details?: unknown }).details
  const stderr =
    details !== null && typeof details === 'object' && 'stderr' in details
      ? (details as { readonly stderr?: unknown }).stderr
      : undefined
  return typeof stderr === 'string' && stderr.length > 0
    ? `${error.message}\n${stderr}`
    : error.message
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
  const source =
    task.repoGroupId !== null && task.repoGroupId.length > 0
      ? { repoGroupId: task.repoGroupId }
      : task.cachedRepoId !== null && task.cachedRepoId.length > 0
        ? {
            cachedRepoId: task.cachedRepoId,
            ...(task.baseBranch === '' ? {} : { ref: task.baseBranch }),
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

function workspaceRepoRows(
  taskId: string,
  repositories: readonly PostgresqlTaskRouteWorkspaceRepository[],
) {
  return repositories.map((repository) => ({
    taskId,
    repoIndex: repository.repoIndex,
    repoPath: repository.repoPath,
    repoUrl: repository.repoUrl,
    cachedRepoId: repository.cachedRepoId,
    baseBranch: repository.baseBranch,
    branch: repository.branch,
    workingBranch: repository.workingBranch,
    baseCommit: repository.baseCommit,
    worktreePath: repository.worktreePath,
    worktreeDirName: repository.worktreeDirName,
    mountPath: repository.mountPath,
    subdir: repository.subdir,
    readonly: repository.readonly,
    workspaceProfileVersion: repository.workspaceProfileVersion,
    workspaceProfileDigest: repository.workspaceProfileDigest,
    hasSubmodules: repository.hasSubmodules,
    submoduleInitOk: repository.submoduleInitOk,
    submoduleInitError: repository.submoduleInitError,
  }))
}

async function reclaimStalePreparationArtifacts(
  dependencies: PostgresqlRepositoryPreparationRetryDependencies,
  task: TaskRow,
): Promise<void> {
  if (!/^[0-9A-Za-z_-]+$/.test(task.id)) {
    throw new ConflictError(
      'task-id-filesystem-unsafe',
      `task '${task.id}' cannot identify repository-preparation artifacts safely`,
    )
  }
  const store = composePostgresqlRepositoryWorkspaceStore(dependencies.db)
  const cachedRepoIds = new Set<string>()
  if (task.cachedRepoId !== null && task.cachedRepoId.length > 0) {
    cachedRepoIds.add(task.cachedRepoId)
  }
  if (task.repoGroupId !== null && task.repoGroupId.length > 0) {
    try {
      const layout = await resolveRepoGroupLayout(store, task.repoGroupId)
      for (const repository of layout.repos) cachedRepoIds.add(repository.cachedRepoId)
    } catch (error) {
      dependencies.log.warn('could not resolve repository group while reclaiming retry artifacts', {
        taskId: task.id,
        error: diagnosticText(error),
      })
    }
  }

  const worktreesRoot = join(dependencies.appHome, 'worktrees')
  try {
    for (const directory of await readdir(worktreesRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      await rm(join(worktreesRoot, directory.name, task.id), { recursive: true, force: true })
    }
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code
    if (code !== 'ENOENT') {
      dependencies.log.warn('could not reclaim stale repository-preparation directories', {
        taskId: task.id,
        error: diagnosticText(error),
      })
    }
  }

  for (const cachedRepoId of cachedRepoIds) {
    const repository = await store.findCachedRepoById(cachedRepoId)
    if (repository === null) continue
    try {
      await withWorktreeRegistryLock(repository.localPath, async () => {
        await runGit(repository.localPath, ['worktree', 'prune'])
        const listed = await runGit(repository.localPath, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/agent-workflow/${task.id}`,
          `refs/heads/agent-workflow/${task.id}-*`,
        ])
        for (const ref of listed.stdout
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean)) {
          await runGit(repository.localPath, ['update-ref', '-d', ref])
        }
      })
    } catch (error) {
      dependencies.log.warn('could not reclaim stale repository-preparation Git state', {
        taskId: task.id,
        cachedRepoId,
        error: diagnosticText(error),
      })
    }
  }
}

async function loadRetrySnapshot(
  dependencies: PostgresqlRepositoryPreparationRetryDependencies,
  taskId: string,
): Promise<{ readonly task: TaskRow; readonly prep: PrepRow }> {
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
      cachedRepoId: tasks.cachedRepoId,
      repoGroupId: tasks.repoGroupId,
      worktreePath: tasks.worktreePath,
      baseBranch: tasks.baseBranch,
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
  if (task.worktreePath !== '') {
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
  const prepRows = await dependencies.db
    .select({ id: nodeRuns.id, retryIndex: nodeRuns.retryIndex, status: nodeRuns.status })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
    .orderBy(desc(nodeRuns.retryIndex), desc(nodeRuns.id))
    .limit(1)
  const prep = prepRows[0]
  if (prep === undefined) {
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

async function recordPreparationFailure(
  dependencies: PostgresqlRepositoryPreparationRetryDependencies,
  snapshot: { readonly task: TaskRow; readonly prep: PrepRow },
  error: unknown,
): Promise<void> {
  const now = dependencies.now?.() ?? Date.now()
  const nextId = dependencies.id ?? ulid
  const operationRef = `repo-prep-retry:${snapshot.task.id}:${nextId()}`
  const summary = diagnosticText(error)
  const committed = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    await assertPostgresqlTaskOwnerlessTx(tx, snapshot.task.id)
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
          eq(tasks.worktreePath, ''),
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
    const prepRunId = await createPostgresqlNodeRunMintParticipantInTx(tx).mint({
      id: nextId(),
      taskId: snapshot.task.id,
      nodeId: REPO_PREP_NODE_ID,
      status: 'failed',
      cause: 'retry-node',
      retryIndex: nextRetryIndex([snapshot.prep]),
      iteration: 0,
      overrides: { startedAt: now, finishedAt: now, errorMessage: summary },
    })
    const failedRows = await tx
      .update(tasks)
      .set({
        status: 'failed',
        finishedAt: now,
        errorSummary: `repo preparation failed: ${summary}`,
        errorMessage: summary,
        failedNodeId: REPO_PREP_NODE_ID,
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, snapshot.task.id),
          eq(tasks.status, 'pending'),
          eq(tasks.lifecycleEventRevision, admitted.revision),
        ),
      )
      .returning({ revision: tasks.lifecycleEventRevision })
    const failed = failedRows[0]
    if (failed === undefined) {
      throw new ConflictError(
        'task-still-running',
        `task '${snapshot.task.id}' changed while repository preparation failed`,
      )
    }
    const admittedEvent = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId: snapshot.task.id,
      lifecycleRevision: admitted.revision,
      previousStatus: snapshot.task.status as TaskStatus,
      status: 'pending',
      errorSummary: null,
      occurredAt: now,
      identity: { operationRef, eventGroupId: operationRef, eventGroupOrdinal: 0 },
    })
    const failedEvent = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId: snapshot.task.id,
      lifecycleRevision: failed.revision,
      previousStatus: 'pending',
      status: 'failed',
      errorSummary: `repo preparation failed: ${summary}`,
      nodeChanges: [
        {
          nodeRunId: prepRunId,
          nodeId: REPO_PREP_NODE_ID,
          status: 'failed',
          cause: 'retry-node',
        },
      ],
      occurredAt: now,
      identity: { operationRef, eventGroupId: operationRef, eventGroupOrdinal: 1 },
    })
    return [admittedEvent, failedEvent].filter(
      (event): event is TaskExecutionPostCommitEventRef => event !== null,
    )
  })
  await publishCommittedEventsAfterCommit(committed)
}

async function commitPreparedWorkspace(
  dependencies: PostgresqlRepositoryPreparationRetryDependencies,
  snapshot: { readonly task: TaskRow; readonly prep: PrepRow },
  workspace: PostgresqlTaskRoutePreparedWorkspace,
): Promise<string> {
  const now = dependencies.now?.() ?? Date.now()
  const nextId = dependencies.id ?? ulid
  const operationRef = `repo-prep-retry:${snapshot.task.id}:${nextId()}`
  const intentId = nextId()
  const committed = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    await assertPostgresqlTaskOwnerlessTx(tx, snapshot.task.id)
    const admittedRows = await tx
      .update(tasks)
      .set({
        status: 'pending',
        finishedAt: null,
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
        repoPath: workspace.repoPath,
        repoUrl: workspace.repoUrl,
        cachedRepoId: workspace.cachedRepoId,
        repoGroupId: workspace.repoGroupId,
        repoGroupName: workspace.repoGroupName,
        worktreePath: workspace.worktreePath,
        baseBranch: workspace.baseBranch,
        branch:
          workspace.branch === ''
            ? (snapshot.task.workingBranch ?? `agent-workflow/${snapshot.task.id}`)
            : workspace.branch,
        baseCommit: workspace.baseCommit,
        repoCount: workspace.repositories.length,
        spaceKind: workspace.spaceKind,
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, snapshot.task.id),
          eq(tasks.status, snapshot.task.status),
          eq(tasks.lifecycleEventRevision, snapshot.task.lifecycleEventRevision),
          eq(tasks.worktreePath, ''),
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
    await tx.delete(taskRepos).where(eq(taskRepos.taskId, snapshot.task.id))
    await tx.delete(taskSpaceNodes).where(eq(taskSpaceNodes.taskId, snapshot.task.id))
    await tx.insert(taskRepos).values(workspaceRepoRows(snapshot.task.id, workspace.repositories))
    if (workspace.nodePaths.length > 0) {
      await tx.insert(taskSpaceNodes).values(
        workspace.nodePaths.map((nodePath) => ({
          taskId: snapshot.task.id,
          nodePath,
          schemaVersion: 1,
        })),
      )
    }
    const prepRunId = await createPostgresqlNodeRunMintParticipantInTx(tx).mint({
      id: nextId(),
      taskId: snapshot.task.id,
      nodeId: REPO_PREP_NODE_ID,
      status: 'done',
      cause: 'retry-node',
      retryIndex: nextRetryIndex([snapshot.prep]),
      iteration: 0,
      overrides: { startedAt: now, finishedAt: now },
    })
    await submitPostgresqlTaskContinuationTx(tx, {
      taskId: snapshot.task.id,
      intentId,
      kind: 'retry-repository-preparation',
      source: 'auto',
      actorUserId: null,
      payload: { v: 1, phase: 'repository-preparation' },
      now,
      advanceOperationGeneration: true,
    })
    const event = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId: snapshot.task.id,
      lifecycleRevision: admitted.revision,
      previousStatus: snapshot.task.status as TaskStatus,
      status: 'pending',
      errorSummary: null,
      nodeChanges: [
        {
          nodeRunId: prepRunId,
          nodeId: REPO_PREP_NODE_ID,
          status: 'done',
          cause: 'retry-node',
        },
      ],
      occurredAt: now,
      identity: { operationRef, eventGroupId: operationRef, eventGroupOrdinal: 0 },
    })
    return { intentId, events: event === null ? [] : [event] }
  })
  workspace.commit()
  await publishCommittedEventsAfterCommit(committed.events)
  return committed.intentId
}

/** PostgreSQL-native repository-preparation retry. Filesystem work happens
 * while the task is terminal; only a complete workspace can win the single
 * SERIALIZABLE CAS that installs projections, mints the prep attempt and
 * admits its continuation. */
export function createPostgresqlRepositoryPreparationRetryCommand(
  dependencies: PostgresqlRepositoryPreparationRetryDependencies,
): RepositoryPreparationRetryCommand {
  const inFlight = new Set<string>()
  return Object.freeze({
    async retry(taskId: string): Promise<void> {
      if (inFlight.has(taskId)) {
        throw new ConflictError(
          'task-still-running',
          `task '${taskId}' already has a repository-preparation retry in progress`,
        )
      }
      inFlight.add(taskId)
      let workspace: PostgresqlTaskRoutePreparedWorkspace | undefined
      let committed = false
      try {
        const snapshot = await loadRetrySnapshot(dependencies, taskId)
        await reclaimStalePreparationArtifacts(dependencies, snapshot.task)
        const task = retryPreparationInput(snapshot.task)
        const gitCommitIdentity = retryGitIdentity(snapshot.task)
        try {
          workspace = await dependencies.workspace.prepare({
            taskId,
            task,
            gitCommitIdentity,
          })
        } catch (error) {
          await recordPreparationFailure(dependencies, snapshot, error)
          throw error
        }
        if (workspace.taskId !== taskId) {
          throw new Error(
            `postgresql-repository-preparation-workspace-mismatch: expected '${taskId}', got '${workspace.taskId}'`,
          )
        }
        if (workspace.earlyError !== null || workspace.repositories.length === 0) {
          const error = new DomainError(
            'repo-prep-failed',
            workspace.earlyError ?? 'repository preparation produced no repository projection',
            502,
          )
          await workspace.rollback()
          workspace = undefined
          await recordPreparationFailure(dependencies, snapshot, error)
          throw error
        }
        const intentId = await commitPreparedWorkspace(dependencies, snapshot, workspace)
        committed = true
        await dependencies.coordinator.submit({
          taskId,
          intentId,
          completionMode: 'background',
        })
      } finally {
        if (workspace !== undefined && !committed) await workspace.rollback()
        inFlight.delete(taskId)
      }
    },
  })
}
