// RFC-387: fusion uses the session's drive and cancellation commands on both engines.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { admitTransferredWorkspace } from './transferredWorkspaceAdmission'
import type {
  FusionEngineTaskLaunch,
  FusionEngineTaskOperations,
} from '@/modules/knowledge-evolution/public/participants'
import type {
  FusionWorkspaceEffects,
  FusionWorkspacePreparation,
} from '@/modules/source-control/public/participants'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { ConflictError, ValidationError } from '@/util/errors'
import { layoutBuiltinWorkflowSnapshotJson } from '@/services/task'
import type { TaskDriveCoordinator } from '../application/drive/taskDriveTypes'
import type { TaskCancellationCommand } from '../public/commands'
import { sha256Hex } from '../domain/digest'
import { launchInFusionWorkspace, releaseFusionWorkspace } from './fusionWorkspaceLaunch'
import { withSerializableTaskExecution } from './taskLifecycleTransaction'
import { appendTaskCreatedCommittedEvent } from './taskLifecycleCommittedEvents'

export interface FusionEngineTaskDependencies {
  readonly db: PersistenceDb
  readonly coordinator: TaskDriveCoordinator
  readonly cancellation: TaskCancellationCommand
  readonly workspaces: FusionWorkspaceEffects
}

function taskSlotPath(taskId: string, workflowVersion: number): string {
  return JSON.stringify([
    {
      stableNodeKey: 'task-root',
      frozenOccurrenceKey: taskId,
      workflowRevision: workflowVersion,
    },
  ])
}

async function validateCollaborators(
  db: PersistenceDb,
  command: FusionEngineTaskLaunch,
): Promise<readonly string[]> {
  const userIds = [...new Set([command.ownerUserId, ...(command.collaboratorUserIds ?? [])])]
  const { users } = tablesOf(db)
  const active = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.status, 'active')))
  const activeIds = new Set(active.map((row) => row.id))
  const invalid = userIds.filter((id) => !activeIds.has(id))
  if (invalid.length > 0) {
    throw new ValidationError(
      'task-collaborator-invalid',
      `inactive or missing task member(s): ${invalid.join(', ')}`,
    )
  }
  return userIds
}

async function insertFusionTask(
  dependencies: FusionEngineTaskDependencies,
  command: FusionEngineTaskLaunch,
  workspace: FusionWorkspacePreparation,
): Promise<string> {
  const { workflows } = tablesOf(dependencies.db)
  const workflowRows = await dependencies.db
    .select({
      id: workflows.id,
      definition: workflows.definition,
      version: workflows.version,
    })
    .from(workflows)
    .where(eq(workflows.id, command.workflowId))
    .limit(1)
  const workflow = workflowRows[0]
  if (workflow === undefined) {
    throw new ValidationError(
      'workflow-not-found',
      `fusion workflow '${command.workflowId}' not found`,
    )
  }
  const memberIds = await validateCollaborators(dependencies.db, command)
  const now = Date.now()
  const intentId = ulid()
  const slotPathJson = taskSlotPath(command.taskId, workflow.version)
  const eventRefs = await withSerializableTaskExecution(dependencies.db, async (tx) => {
    await admitTransferredWorkspace(tx, {
      kind: 'fusion',
      taskId: command.taskId,
      worktreePath: workspace.worktreePath,
      baseCommit: workspace.baseCommit,
      ownerRef: command.taskId,
    })
    const { tasks, taskRepos, taskCollaborators, taskExecutionIntents } = tablesOf(tx)
    await insertOne(tx, tasks, {
      id: command.taskId,
      name: command.name,
      workflowId: workflow.id,
      workflowSnapshot: layoutBuiltinWorkflowSnapshotJson(workflow.definition),
      workflowVersion: workflow.version,
      repoPath: workspace.worktreePath,
      worktreePath: workspace.worktreePath,
      baseBranch: 'fusion',
      branch: 'fusion',
      baseCommit: workspace.baseCommit,
      status: 'pending',
      inputs: JSON.stringify(command.inputs),
      startedAt: now,
      ownerUserId: command.ownerUserId,
      launchOrigin: command.initiator,
      catalogVisibility: 'public',
      platformInputPathsJson:
        command.platformInputPaths.length === 0 ? null : JSON.stringify(command.platformInputPaths),
      spaceKind: 'internal',
      branchStartedAt: now,
      rootTaskId: command.taskId,
      executionLineageId: command.taskId,
      lineageSlotPathJson: slotPathJson,
    })
    await insertOne(tx, taskRepos, {
      taskId: command.taskId,
      repoIndex: 0,
      repoPath: workspace.worktreePath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: 'fusion',
      branch: 'fusion',
      workingBranch: null,
      baseCommit: workspace.baseCommit,
      worktreePath: workspace.worktreePath,
      worktreeDirName: '',
      mountPath: '',
      subdir: '',
      readonly: false,
    })
    await tx.insert(taskCollaborators).values(
      memberIds.map((userId) => ({
        taskId: command.taskId,
        userId,
        role: userId === command.ownerUserId ? ('owner' as const) : ('collaborator' as const),
        addedBy: command.ownerUserId,
        addedAt: now,
      })),
    )
    await insertOne(tx, taskExecutionIntents, {
      id: intentId,
      taskId: command.taskId,
      kind: 'launch',
      state: 'pending',
      source: 'internal',
      requestHash: sha256Hex(
        JSON.stringify({
          kind: 'launch',
          taskId: command.taskId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          continuationSlotKey: 'task-root',
          operationGeneration: 0,
        }),
      ),
      payloadJson: JSON.stringify({ v: 1, workflowId: workflow.id }),
      executionLineageId: command.taskId,
      continuationSlotKey: 'task-root',
      slotPathJson,
      operationGeneration: 0,
      expectedTaskRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    const eventRef = await appendTaskCreatedCommittedEvent(tx, {
      taskId: command.taskId,
      status: 'pending',
      errorSummary: null,
      occurredAt: now,
    })
    return eventRef === null ? [] : [eventRef]
  })
  await publishCommittedEventsAfterCommit(eventRefs)
  return intentId
}

export function createFusionEngineTaskOperations(
  dependencies: FusionEngineTaskDependencies,
): FusionEngineTaskOperations {
  async function loadTask(taskId: string) {
    const { tasks } = tablesOf(dependencies.db)
    const rows = await dependencies.db
      .select({
        status: tasks.status,
        errorSummary: tasks.errorSummary,
        worktreePath: tasks.worktreePath,
        baseCommit: tasks.baseCommit,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    return rows[0] ?? null
  }
  async function launchPrepared(
    command: FusionEngineTaskLaunch,
    workspace: FusionWorkspacePreparation,
  ) {
    const intentId = await insertFusionTask(dependencies, command, workspace)
    const receipt = await dependencies.coordinator.submit({
      taskId: command.taskId,
      intentId,
      completionMode: command.completionMode ?? 'background',
    })
    if (receipt.kind === 'not-attached') {
      throw new ConflictError(
        'task-launch-not-attached',
        `fusion task '${command.taskId}' could not attach its launch intent`,
      )
    }
  }
  return Object.freeze({
    async launch(command: FusionEngineTaskLaunch) {
      await launchInFusionWorkspace({
        workspaces: dependencies.workspaces,
        request: {
          fusionId: command.fusionId,
          iteration: command.iteration,
          taskId: command.taskId,
          base: command.seed.base,
          overlay: command.seed.overlay,
        },
        admitted: async () => (await loadTask(command.taskId)) !== null,
        launch: (workspace) => launchPrepared(command, workspace),
      })
    },
    load: loadTask,
    async collect(taskId: string) {
      const task = await loadTask(taskId)
      if (task === null) return null
      if (task.baseCommit === null) throw new Error('fusion engine task has no baseline commit')
      return await dependencies.workspaces.collect({
        taskId,
        worktreePath: task.worktreePath,
        baseCommit: task.baseCommit,
      })
    },
    async release(taskId: string) {
      const task = await loadTask(taskId)
      await releaseFusionWorkspace(
        dependencies.workspaces,
        task === null ? null : { taskId, worktreePath: task.worktreePath },
      )
    },
    async cancel(taskId: string) {
      await dependencies.cancellation.cancel({ taskId, cause: { kind: 'user' } })
    },
  })
}
