// RFC-349 — PostgreSQL task continuation/cascade control.  Admission, intent
// minting and lifecycle events commit atomically; native-session fencing and
// git rollback complete before the replacement driver can touch a workspace.

import {
  CANCELABLE_TASK_STATUSES,
  REPO_PREP_NODE_ID,
  RESUMABLE_TASK_STATUSES,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  taskWorkspacePhase,
  type NodeRunStatus,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { ulid } from 'ulid'

import {
  nodeRuns,
  runtimeSessionLeases as runtimeSessionLeaseRows,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import {
  loadRollbackTargetFrom,
  rollbackNodeRunWorktrees,
  type RollbackOutcome,
} from '@/services/nodeRollback'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { killStaleRunProcessTree, type StaleRunKillOutcome } from '@/util/process'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import type { ChildTaskLifecycleParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { TaskExecutionModule } from '../composition'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { taskStopProjection } from '../domain/sourceTermination'
import { PostgresqlTaskRollbackQueries } from './postgresqlTaskRollbackQueries'
import { createPostgresqlTaskDriverLifecyclePort } from './postgresqlTaskDriverLifecycle'
import { submitPostgresqlTaskContinuationTx } from './postgresqlTaskExecutionIntentPersistence'
import { terminalizePostgresqlTaskExecutionIntentsTx } from './postgresqlTaskExecutionIntentTerminalPersistence'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  assertPostgresqlTaskOwnerlessTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

const NODE_CANCELABLE_STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
] as const satisfies readonly NodeRunStatus[]

const log = createLogger('task-execution.postgresql-child-lifecycle')

type ResumeRun = Readonly<{
  id: string
  nodeId: string
  status: NodeRunStatus
  parentNodeRunId: string | null
  childTaskId: string | null
  preSnapshot: string | null
  preSnapshotReposJson: string | null
  pid: number | null
  startedAt: number | null
  spawnBinaryPath: string | null
  spawnLaunchNonce: string | null
}>

type ResumeTask = Readonly<{
  id: string
  status: TaskStatus
  lifecycleEventRevision: number
  parentTaskId: string | null
  parentNodeRunId: string | null
  workflowSnapshot: string
  refClosureJson: string | null
  triggerContextJson: string | null
  worktreePath: string
  workspacePruningAt: number | null
  workspacePrunedAt: number | null
  sourceTerminationFence: 'closed' | 'merged' | null
}>

export interface PostgresqlChildTaskLifecycleDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly persistence: TaskExecutionPersistence
  readonly executionModule: TaskExecutionModule
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  /** Source-control selected finalizer for a terminal workspace-prune claim. */
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly log: TaskExecutionTopologyLogger
}

function selectResumeRollbackTargets(runs: readonly ResumeRun[]): readonly ResumeRun[] {
  const latest = new Map<string, ResumeRun>()
  for (const run of runs) {
    if (run.parentNodeRunId !== null) continue
    const previous = latest.get(run.nodeId)
    if (previous === undefined || run.id > previous.id) latest.set(run.nodeId, run)
  }
  return [...latest.values()].filter(
    (run) => (run.status === 'failed' || run.status === 'interrupted') && run.childTaskId === null,
  )
}

function snapshotLost(outcome: RollbackOutcome): string | null {
  const failures = outcome.failures.filter((failure) => failure.code === 'snapshot-missing')
  if (failures.length === 0) return null
  return failures
    .map((failure) =>
      failure.worktreeDirName === undefined
        ? failure.message
        : `${failure.worktreeDirName}: ${failure.message}`,
    )
    .join('; ')
}

function validateFrozenTrigger(task: ResumeTask): void {
  const source = parseTriggerContextJson(task.triggerContextJson)
  try {
    const workflow = migrateWorkflowDefinitionToLatest(
      WorkflowDefinitionSchema.parse(JSON.parse(task.workflowSnapshot)),
    )
    assertTriggerPreflight({ root: workflow, closureJson: task.refClosureJson, source })
  } catch (error) {
    // Preserve the legacy recovery posture for historical corrupt snapshots;
    // trigger failures from a valid frozen snapshot remain authoritative.
    if (error instanceof ValidationError && error.code.startsWith('trigger-')) throw error
  }
}

async function loadResumeTask(db: PostgresqlDatabaseClient, taskId: string): Promise<ResumeTask> {
  const row = (
    await db
      .select({
        id: tasks.id,
        status: tasks.status,
        lifecycleEventRevision: tasks.lifecycleEventRevision,
        parentTaskId: tasks.parentTaskId,
        parentNodeRunId: tasks.parentNodeRunId,
        workflowSnapshot: tasks.workflowSnapshot,
        refClosureJson: tasks.refClosureJson,
        triggerContextJson: tasks.triggerContextJson,
        worktreePath: tasks.worktreePath,
        workspacePruningAt: tasks.workspacePruningAt,
        workspacePrunedAt: tasks.workspacePrunedAt,
        sourceTerminationFence: tasks.sourceTerminationFence,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (row === undefined) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  return { ...row, status: row.status as TaskStatus }
}

async function assertResumeAdmission(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
  task: ResumeTask,
): Promise<void> {
  if (dependencies.executionModule.runtimeRegistry.hasTask(task.id)) {
    throw new ConflictError(
      'task-not-resumable',
      `task '${task.id}' is actively running (scheduler attached); cannot resume`,
    )
  }
  if (!RESUMABLE_TASK_STATUSES.includes(task.status)) {
    throw new ConflictError(
      'task-not-resumable',
      `task '${task.id}' is ${task.status}; only [${RESUMABLE_TASK_STATUSES.join('/')}] tasks can resume`,
    )
  }
  if (task.parentTaskId !== null && task.parentNodeRunId !== null) {
    const parent = (
      await dependencies.db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, task.parentNodeRunId))
        .limit(1)
    )[0]
    if (
      parent !== undefined &&
      ['done', 'failed', 'canceled', 'interrupted', 'exhausted'].includes(parent.status)
    ) {
      throw new ConflictError(
        'call-row-finalized',
        `task '${task.id}' is a child execution whose call node run already settled ('${parent.status}'); resume the parent's call node instead`,
      )
    }
  }
  validateFrozenTrigger(task)

  const hasRepoPrepRow =
    (
      await dependencies.db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
        .limit(1)
    )[0] !== undefined
  const phase = taskWorkspacePhase({
    worktreePath: task.worktreePath,
    workspacePruningAt: task.workspacePruningAt,
    workspacePrunedAt: task.workspacePrunedAt,
    hasRepoPrepRow,
  })
  if (phase === 'preparing') {
    throw new ConflictError(
      'task-repo-prep-incomplete',
      `task '${task.id}' has no worktree yet; retry repository preparation instead of resume`,
    )
  }
  if (phase === 'pruning') {
    throw new ConflictError(
      'workspace-pruning',
      `task '${task.id}' workspace is being reclaimed by GC`,
    )
  }
  if (phase === 'pruned' || task.worktreePath === '' || !existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `task '${task.id}' worktree is unavailable; cannot resume`,
      410,
    )
  }
  const rollbackTarget = await new PostgresqlTaskRollbackQueries(dependencies.db).load(task.id)
  if (
    rollbackTarget !== null &&
    rollbackTarget.repoCount > 1 &&
    rollbackTarget.repositories.length > 0 &&
    !rollbackTarget.repositories.some((repository) => existsSync(repository.worktreePath))
  ) {
    throw new DomainError(
      'task-worktree-missing',
      `task '${task.id}' has no remaining repository worktree; cannot resume`,
      410,
    )
  }
  if (task.sourceTerminationFence !== null) {
    throw new ConflictError(
      task.sourceTerminationFence === 'closed'
        ? 'task-source-terminal-closed'
        : 'task-source-terminal-merged',
      `task '${task.id}' is fenced by an MR/PR ${task.sourceTerminationFence} event`,
    )
  }
}

async function admitResume(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
  task: ResumeTask,
  actorUserId: string | undefined,
): Promise<{
  readonly intentId: string
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}> {
  const intentId = ulid()
  const now = Date.now()
  const eventRefs = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    await assertPostgresqlTaskOwnerlessTx(tx, task.id)
    const changed = await tx
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
          eq(tasks.id, task.id),
          eq(tasks.status, task.status),
          eq(tasks.lifecycleEventRevision, task.lifecycleEventRevision),
          isNull(tasks.workspacePruningAt),
          isNull(tasks.workspacePrunedAt),
          isNull(tasks.sourceTerminationFence),
        ),
      )
      .returning({ lifecycleEventRevision: tasks.lifecycleEventRevision })
    const row = changed[0]
    if (row === undefined) {
      throw new ConflictError(
        'task-not-resumable',
        `task '${task.id}' changed state while admitting resume`,
      )
    }
    await submitPostgresqlTaskContinuationTx(tx, {
      taskId: task.id,
      intentId,
      kind: 'resume',
      source: actorUserId === undefined ? 'internal' : 'rest',
      actorUserId: actorUserId ?? null,
      payload: { v: 1, event: 'resume' },
      now,
      advanceOperationGeneration: true,
    })
    const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId: task.id,
      lifecycleRevision: row.lifecycleEventRevision,
      previousStatus: task.status,
      status: 'pending',
      errorSummary: null,
      occurredAt: now,
    })
    return eventRef === null ? [] : [eventRef]
  })
  await publishCommittedEventsAfterCommit(eventRefs)
  return { intentId, eventRefs }
}

async function markUnsafeResume(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
  input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly nodeId: string
    readonly executionContext: Parameters<
      TaskExecutionPersistence['runtimeLifecycle']['trySet']
    >[0]['executionContext']
    readonly code: 'snapshot-lost' | 'live-child-survived'
    readonly detail: string
  },
): Promise<never> {
  const now = Date.now()
  await dependencies.persistence.runtimeLifecycle.trySet({
    taskId: input.taskId,
    to: 'failed',
    allowedFrom: ['pending'],
    extra: {
      finishedAt: now,
      errorSummary: input.code,
      errorMessage: input.detail,
      failedNodeId: input.nodeId,
    },
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    now,
    reason: `resumeTask:${input.code}`,
  })
  await dependencies.persistence.recoveryAdministration.recordEvent({
    id: ulid(),
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    actor: 'system',
    kind: input.code,
    reason: input.detail,
    beforeJson: JSON.stringify({ status: 'pending' }),
    afterJson: JSON.stringify({ status: 'failed' }),
    createdAt: now,
  })
  throw new ConflictError(input.code, input.detail)
}

async function reapRun(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
  input: {
    readonly taskId: string
    readonly run: ResumeRun
    readonly heldLease: boolean
    readonly executionContext: Parameters<
      TaskExecutionPersistence['runtimeLifecycle']['trySet']
    >[0]['executionContext']
  },
): Promise<void> {
  const outcome: StaleRunKillOutcome = await killStaleRunProcessTree(input.run)
  if (outcome === 'killed') {
    dependencies.log.warn('stale runtime child reaped before task resume', {
      taskId: input.taskId,
      nodeRunId: input.run.id,
      pid: input.run.pid,
    })
  }
  const unsafe = input.heldLease
    ? outcome !== 'not-alive' && outcome !== 'killed'
    : outcome === 'kill-failed'
  if (unsafe) {
    await markUnsafeResume(dependencies, {
      taskId: input.taskId,
      nodeRunId: input.run.id,
      nodeId: input.run.nodeId,
      executionContext: input.executionContext,
      code: 'live-child-survived',
      detail: `node_run ${input.run.id} child reap could not be proven (${outcome}, pid ${input.run.pid ?? '?'}); refusing workspace rollback`,
    })
  }
  if (
    input.heldLease &&
    (await dependencies.runtimeSessionLeases.repairAfterOrphanReap(input.run.id)) !== 1
  ) {
    await markUnsafeResume(dependencies, {
      taskId: input.taskId,
      nodeRunId: input.run.id,
      nodeId: input.run.nodeId,
      executionContext: input.executionContext,
      code: 'live-child-survived',
      detail: `node_run ${input.run.id} retained a native runtime session lease after reap`,
    })
  }
}

async function rollbackForResume(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
  input: {
    readonly taskId: string
    readonly executionContext: Parameters<
      TaskExecutionPersistence['runtimeLifecycle']['trySet']
    >[0]['executionContext']
  },
): Promise<void> {
  const rollbackTarget = await loadRollbackTargetFrom(
    new PostgresqlTaskRollbackQueries(dependencies.db),
    input.taskId,
  )
  if (rollbackTarget === null) {
    throw new NotFoundError('task-not-found', `task '${input.taskId}' not found`)
  }
  const rows = await dependencies.db
    .select({
      id: nodeRuns.id,
      nodeId: nodeRuns.nodeId,
      status: nodeRuns.status,
      parentNodeRunId: nodeRuns.parentNodeRunId,
      childTaskId: nodeRuns.childTaskId,
      preSnapshot: nodeRuns.preSnapshot,
      preSnapshotReposJson: nodeRuns.preSnapshotReposJson,
      pid: nodeRuns.pid,
      startedAt: nodeRuns.startedAt,
      spawnBinaryPath: nodeRuns.spawnBinaryPath,
      spawnLaunchNonce: nodeRuns.spawnLaunchNonce,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, input.taskId))
  const runs: readonly ResumeRun[] = rows.map((row) => ({
    ...row,
    status: row.status as NodeRunStatus,
  }))
  const rollbackRuns = selectResumeRollbackTargets(runs)

  // Held native sessions are fenced even when their run is not one of the
  // top-level rollback rows (for example a nested framework child).
  const held = await dependencies.db
    .select({ nodeRunId: runtimeSessionLeaseRows.leaseNodeRunId })
    .from(runtimeSessionLeaseRows)
    .where(
      and(
        eq(runtimeSessionLeaseRows.taskId, input.taskId),
        isNotNull(runtimeSessionLeaseRows.leaseNodeRunId),
      ),
    )
  const heldIds = new Set(held.flatMap((row) => (row.nodeRunId === null ? [] : [row.nodeRunId])))
  for (const nodeRunId of heldIds) {
    const run = runs.find((candidate) => candidate.id === nodeRunId)
    if (run === undefined) {
      return await markUnsafeResume(dependencies, {
        taskId: input.taskId,
        nodeRunId,
        nodeId: '(missing)',
        executionContext: input.executionContext,
        code: 'live-child-survived',
        detail: `native runtime session owner node_run ${nodeRunId} is missing`,
      })
    }
    await reapRun(dependencies, {
      taskId: input.taskId,
      run,
      heldLease: true,
      executionContext: input.executionContext,
    })
  }

  for (const run of rollbackRuns) {
    const outcome = await rollbackNodeRunWorktrees(
      rollbackTarget,
      run,
      { resetOnEmptySnapshot: false, checkOnly: true },
      log,
    )
    const missing = snapshotLost(outcome)
    if (missing !== null) {
      await markUnsafeResume(dependencies, {
        taskId: input.taskId,
        nodeRunId: run.id,
        nodeId: run.nodeId,
        executionContext: input.executionContext,
        code: 'snapshot-lost',
        detail: `node_run ${run.id} pre-snapshot is missing: ${missing}`,
      })
    }
  }
  for (const run of rollbackRuns) {
    if (!heldIds.has(run.id)) {
      await reapRun(dependencies, {
        taskId: input.taskId,
        run,
        heldLease: false,
        executionContext: input.executionContext,
      })
    }
  }
  for (const run of rollbackRuns) {
    const outcome = await rollbackNodeRunWorktrees(
      rollbackTarget,
      run,
      { resetOnEmptySnapshot: false },
      log,
    )
    const missing = snapshotLost(outcome)
    if (missing !== null) {
      await markUnsafeResume(dependencies, {
        taskId: input.taskId,
        nodeRunId: run.id,
        nodeId: run.nodeId,
        executionContext: input.executionContext,
        code: 'snapshot-lost',
        detail: `node_run ${run.id} pre-snapshot is missing: ${missing}`,
      })
    }
  }
}

async function cancelCascade(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
  taskId: string,
  cause:
    | Readonly<{ readonly kind: 'user' }>
    | Readonly<{ readonly kind: 'parent-cascade'; readonly parentTaskId: string }>,
): Promise<void> {
  let stopToken = dependencies.executionModule.runtimeRegistry.tokenForTask(taskId)
  let revokedRevision: number | null = null
  const committed = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    const task = (
      await tx
        .select({
          status: tasks.status,
          lifecycleEventRevision: tasks.lifecycleEventRevision,
          errorSummary: tasks.errorSummary,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    if (task === undefined) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    if (!CANCELABLE_TASK_STATUSES.includes(task.status as TaskStatus)) {
      throw new ConflictError(
        'task-not-cancelable',
        `task '${taskId}' is already terminal (${task.status}); nothing to cancel`,
      )
    }
    const owner = (
      await tx.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
    )[0]
    if (owner?.state === 'claimed') {
      stopToken ??= dependencies.executionModule.runtimeRegistry.tokenForOwner(owner)
      const revoked = await tx
        .update(taskExecutionOwners)
        .set({
          state: 'revoked',
          revision: owner.revision + 1,
          recoveryCode: 'terminal-control-cancel',
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(taskExecutionOwners.taskId, taskId),
            eq(taskExecutionOwners.ownerId, owner.ownerId),
            eq(taskExecutionOwners.daemonGeneration, owner.daemonGeneration),
            eq(taskExecutionOwners.epoch, owner.epoch),
            eq(taskExecutionOwners.revision, owner.revision),
            eq(taskExecutionOwners.state, 'claimed'),
          ),
        )
        .returning({ revision: taskExecutionOwners.revision })
      if (revoked[0] === undefined) {
        throw new ConflictError('task-cancel-raced', `task '${taskId}' owner changed`)
      }
      revokedRevision = revoked[0].revision
    }
    const now = Date.now()
    const projection = taskStopProjection(cause)
    const nextRevision = task.lifecycleEventRevision + 1
    const changed = await tx
      .update(tasks)
      .set({
        status: 'canceled',
        finishedAt: now,
        errorSummary: projection.summary,
        errorMessage: projection.code,
        lifecycleEventRevision: nextRevision,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status)))
      .returning({ id: tasks.id })
    if (changed[0] === undefined) {
      throw new ConflictError('task-cancel-raced', `task '${taskId}' changed`)
    }
    const canceledRuns = await tx
      .update(nodeRuns)
      .set({
        status: 'canceled',
        finishedAt: now,
        errorMessage: projection.code,
      })
      .where(and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.status, NODE_CANCELABLE_STATUSES)))
      .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
    await terminalizePostgresqlTaskExecutionIntentsTx(tx, {
      taskId,
      state: 'canceled',
      failureCode: projection.code,
      now,
    })
    const childIds = (
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, taskId), inArray(tasks.status, CANCELABLE_TASK_STATUSES)))
    ).map((child) => child.id)
    const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId,
      lifecycleRevision: nextRevision,
      previousStatus: task.status as TaskStatus,
      status: 'canceled',
      errorSummary: projection.summary,
      nodeChanges: canceledRuns.map((run) => ({
        nodeRunId: run.id,
        nodeId: run.nodeId,
        status: 'canceled',
        cause: projection.code,
      })),
      occurredAt: now,
    })
    return { childIds, eventRefs: eventRef === null ? [] : [eventRef] }
  })
  await publishCommittedEventsAfterCommit(committed.eventRefs)

  if (stopToken !== null) {
    const ticket = dependencies.executionModule.runtimeRegistry.requestStop(stopToken, cause)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const stopped = await Promise.race([
      dependencies.executionModule.runtimeRegistry.awaitStopped(ticket),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 5_000)
      }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)
    if (stopped === null && revokedRevision !== null) {
      const owner = await dependencies.persistence.ownership.read(taskId)
      if (owner?.state === 'revoked' && owner.epoch === stopToken.epoch) {
        await dependencies.persistence.ownership.markRecoveryRequired({
          token: stopToken,
          expectedRevision: owner.revision,
          code: 'terminal-stop-timeout',
          now: Date.now(),
        })
      }
    }
  }
  for (const childId of committed.childIds) {
    try {
      await cancelCascade(dependencies, childId, {
        kind: 'parent-cascade',
        parentTaskId: taskId,
      })
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        (error instanceof ConflictError && error.code === 'task-not-cancelable')
      ) {
        continue
      }
      throw error
    }
  }
}

/**
 * Fully native PostgreSQL child lifecycle participant.  It is also safe for
 * daemon auto-resume of a root task: the child-only parent-row guard is simply
 * skipped when the task has no parent.
 */
export function createPostgresqlChildTaskLifecycleParticipant(
  dependencies: PostgresqlChildTaskLifecycleDependencies,
): ChildTaskLifecycleParticipant {
  const lifecycle = createPostgresqlTaskDriverLifecyclePort({
    db: dependencies.db,
    module: dependencies.executionModule,
    persistence: dependencies.persistence,
    log: dependencies.log,
    finalizeWorkspace: dependencies.finalizeWorkspace,
  })
  return Object.freeze({
    async cancel(input: Parameters<ChildTaskLifecycleParticipant['cancel']>[0]) {
      await cancelCascade(dependencies, input.taskId, input.cause)
    },
    async resume(
      input: Parameters<ChildTaskLifecycleParticipant['resume']>[0],
      topology: Parameters<ChildTaskLifecycleParticipant['resume']>[1],
    ) {
      const task = await loadResumeTask(dependencies.db, input.taskId)
      await assertResumeAdmission(dependencies, task)
      const admitted = await admitResume(dependencies, task, input.runtime.actorUserId)
      const runtime = resolveTaskDriveConfig({
        ...input.runtime.runConfig,
        ensureWorkspaceProfiles: true,
      })
      const coordinator = new DefaultTaskDriveCoordinator({
        runtime,
        lifecycle,
        admittedContinuation: {
          async run(context) {
            await rollbackForResume(dependencies, {
              taskId: input.taskId,
              executionContext: context.execution,
            })
            return { kind: 'ready' as const }
          },
        },
        repositoryPreparation: skipRepositoryPreparation,
        engineOrchestrator: {
          async drive(context) {
            await topology.schedulerDriver.drive({
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
          async report({ taskId, execution, error }) {
            const now = Date.now()
            await dependencies.persistence.runtimeLifecycle.trySet({
              taskId,
              to: 'failed',
              allowedFrom: ['pending', 'running'],
              extra: {
                finishedAt: now,
                errorSummary: 'task resume failed',
                errorMessage: error instanceof Error ? error.message : String(error),
              },
              executionContext: execution,
              now,
              reason: 'postgresql-task-resume',
            })
            await dependencies.persistence.intentTerminalization.terminalize({
              taskId,
              state: 'failed',
              failureCode: 'task-resume-failed',
              now,
              claimedOwnerEpoch: execution.token.epoch,
            })
          },
        },
      })
      await coordinator.submit({
        taskId: input.taskId,
        intentId: admitted.intentId,
        completionMode: 'background',
      })
    },
  })
}
