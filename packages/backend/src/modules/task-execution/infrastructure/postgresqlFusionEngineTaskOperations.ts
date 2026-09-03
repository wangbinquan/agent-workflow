import type {
  FusionEngineTaskLaunch,
  FusionEngineTaskOperations,
} from '@/modules/knowledge-evolution/public/participants'
import { CANCELABLE_TASK_STATUSES, allowedFromStatusesForEvent } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  nodeRuns,
  taskCollaborators,
  taskExecutionIntents,
  taskExecutionOwners,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, ValidationError } from '@/util/errors'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type {
  SchedulerDriverPort,
  TaskExecutionTopologyLogger,
} from '../application/ports/taskExecutionTopology'
import type { TaskExecutionModule } from '../composition'
import { sha256Hex } from '../domain/digest'
import type { OwnershipToken } from '../domain/ownership'
import { createPostgresqlTaskDriverLifecyclePort } from './postgresqlTaskDriverLifecycle'
import { terminalizePostgresqlTaskExecutionIntentsTx } from './postgresqlTaskExecutionIntentTerminalPersistence'
import {
  appendPostgresqlTaskCreatedTx,
  appendPostgresqlTaskLifecycleTransitionTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

const CANCELABLE_NODE_RUN_STATUSES = allowedFromStatusesForEvent({ kind: 'mark-canceled' })

export interface PostgresqlFusionEngineTaskDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly schedulerDriver: SchedulerDriverPort
  readonly persistence: TaskExecutionPersistence
  readonly executionModule: TaskExecutionModule
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly log: TaskExecutionTopologyLogger
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
  db: PostgresqlDatabaseClient,
  command: FusionEngineTaskLaunch,
): Promise<readonly string[]> {
  const userIds = [...new Set([command.ownerUserId, ...(command.collaboratorUserIds ?? [])])]
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
  dependencies: PostgresqlFusionEngineTaskDependencies,
  command: FusionEngineTaskLaunch,
): Promise<string> {
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
  const eventRefs = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    await tx.insert(tasks).values({
      id: command.taskId,
      name: command.name,
      workflowId: workflow.id,
      workflowSnapshot: workflow.definition,
      workflowVersion: workflow.version,
      repoPath: command.worktreePath,
      worktreePath: command.worktreePath,
      baseBranch: 'fusion',
      branch: 'fusion',
      baseCommit: command.baseCommit,
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
    await tx.insert(taskRepos).values({
      taskId: command.taskId,
      repoIndex: 0,
      repoPath: command.worktreePath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: 'fusion',
      branch: 'fusion',
      workingBranch: null,
      baseCommit: command.baseCommit,
      worktreePath: command.worktreePath,
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
    await tx.insert(taskExecutionIntents).values({
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
    const eventRef = await appendPostgresqlTaskCreatedTx(tx, {
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

async function cancelPostgresqlTask(
  dependencies: PostgresqlFusionEngineTaskDependencies,
  taskId: string,
): Promise<void> {
  let stopToken: OwnershipToken | null = null
  let childIds: readonly string[] = []
  const eventRefs = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    const row = (
      await tx
        .select({
          status: tasks.status,
          lifecycleRevision: tasks.lifecycleEventRevision,
          errorSummary: tasks.errorSummary,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    if (row === undefined || !CANCELABLE_TASK_STATUSES.includes(row.status)) {
      return []
    }
    const now = Date.now()
    const owner = (
      await tx.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
    )[0]
    if (owner?.state === 'claimed') {
      stopToken = dependencies.executionModule.runtimeRegistry.tokenForOwner(owner)
      await tx
        .update(taskExecutionOwners)
        .set({
          state: 'revoked',
          revision: owner.revision + 1,
          recoveryCode: 'terminal-control-cancel',
          updatedAt: now,
        })
        .where(
          and(
            eq(taskExecutionOwners.taskId, taskId),
            eq(taskExecutionOwners.state, 'claimed'),
            eq(taskExecutionOwners.revision, owner.revision),
          ),
        )
    }
    const nextRevision = row.lifecycleRevision + 1
    const changed = await tx
      .update(tasks)
      .set({
        status: 'canceled',
        finishedAt: now,
        errorSummary: 'canceled by user',
        errorMessage: 'no active scheduler at cancel time',
        lifecycleEventRevision: nextRevision,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, row.status)))
      .returning({ id: tasks.id })
    if (changed[0] === undefined) throw new ConflictError('task-cancel-raced', 'task changed')
    const canceledRuns = await tx
      .update(nodeRuns)
      .set({ status: 'canceled', finishedAt: now, errorMessage: 'canceled by user' })
      .where(
        and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.status, CANCELABLE_NODE_RUN_STATUSES)),
      )
      .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
    await terminalizePostgresqlTaskExecutionIntentsTx(tx, {
      taskId,
      state: 'canceled',
      failureCode: 'canceled-by-user',
      now,
    })
    childIds = (
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, taskId), inArray(tasks.status, CANCELABLE_TASK_STATUSES)))
    ).map((child) => child.id)
    const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId,
      lifecycleRevision: nextRevision,
      previousStatus: row.status,
      status: 'canceled',
      errorSummary: 'canceled by user',
      nodeChanges: canceledRuns.map((run) => ({
        nodeRunId: run.id,
        nodeId: run.nodeId,
        status: 'canceled' as const,
        cause: 'canceled-by-user',
      })),
      occurredAt: now,
    })
    return eventRef === null ? [] : [eventRef]
  })
  await publishCommittedEventsAfterCommit(eventRefs)
  if (stopToken !== null) {
    const ticket = dependencies.executionModule.runtimeRegistry.requestStop(stopToken, {
      kind: 'user',
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        dependencies.executionModule.runtimeRegistry.awaitStopped(ticket),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  for (const childId of childIds) await cancelPostgresqlTask(dependencies, childId)
}

export function createPostgresqlFusionEngineTaskOperations(
  dependencies: PostgresqlFusionEngineTaskDependencies,
): FusionEngineTaskOperations {
  const lifecycle = createPostgresqlTaskDriverLifecyclePort({
    db: dependencies.db,
    module: dependencies.executionModule,
    persistence: dependencies.persistence,
    log: dependencies.log,
    finalizeWorkspace: dependencies.finalizeWorkspace,
  })
  return Object.freeze({
    async launch(command: FusionEngineTaskLaunch) {
      const intentId = await insertFusionTask(dependencies, command)
      const runtime = resolveTaskDriveConfig({
        appHome: dependencies.appHome,
        ensureWorkspaceProfiles: true,
        ...(command.binaryOverride === undefined ? {} : { binaryOverride: command.binaryOverride }),
        ...(command.configPath === undefined ? {} : { configPath: command.configPath }),
        ...(command.defaultPerNodeTimeoutMs === undefined
          ? {}
          : { defaultPerNodeTimeoutMs: command.defaultPerNodeTimeoutMs }),
        ...(command.defaultNodeRetries === undefined
          ? {}
          : { defaultNodeRetries: command.defaultNodeRetries }),
        ...(command.sessionRestartBudget === undefined
          ? {}
          : { sessionRestartBudget: command.sessionRestartBudget }),
        ...(command.defaultRuntime === undefined ? {} : { defaultRuntime: command.defaultRuntime }),
      })
      const coordinator = new DefaultTaskDriveCoordinator({
        runtime,
        lifecycle,
        repositoryPreparation: skipRepositoryPreparation,
        engineOrchestrator: {
          async drive(context) {
            await dependencies.schedulerDriver.drive({
              taskId: context.taskId,
              appHome: context.runtime.appHome,
              ...context.runtime.runtime,
              ...(context.runtime.ensureWorkspaceProfiles ? { ensureWorkspaceProfiles: true } : {}),
              signal: context.signal,
              executionContext: context.execution,
            })
          },
        },
        failureReporter: {
          async report({ taskId, error, execution }) {
            const now = Date.now()
            await dependencies.persistence.runtimeLifecycle.trySet({
              taskId,
              to: 'failed',
              allowedFrom: ['pending', 'running'],
              extra: {
                finishedAt: now,
                errorSummary: 'fusion engine task failed',
                errorMessage: error instanceof Error ? error.message : String(error),
              },
              executionContext: execution,
              now,
              reason: 'fusion-engine-launch',
            })
            await dependencies.persistence.intentTerminalization.terminalize({
              taskId,
              state: 'failed',
              failureCode: 'fusion-engine-launch-failed',
              now,
            })
          },
        },
      })
      const receipt = await coordinator.submit({
        taskId: command.taskId,
        intentId,
        completionMode: command.awaitScheduler === true ? 'await-settle' : 'background',
      })
      if (receipt.kind === 'not-attached') {
        throw new ConflictError(
          'task-launch-not-attached',
          `fusion task '${command.taskId}' could not attach its launch intent`,
        )
      }
    },
    async load(taskId: string) {
      const rows = await dependencies.db
        .select({
          status: tasks.status,
          errorSummary: tasks.errorSummary,
          worktreePath: tasks.worktreePath,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      return rows[0] ?? null
    },
    async cancel(taskId: string) {
      await cancelPostgresqlTask(dependencies, taskId)
    },
  })
}
