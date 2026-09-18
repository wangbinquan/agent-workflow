// RFC-349 — PostgreSQL task continuation/cascade control.  Admission, intent
// minting and lifecycle events commit atomically; native-session fencing and
// git rollback complete before the replacement driver can touch a workspace.

import {
  CANCELABLE_TASK_STATUSES,
  REPO_PREP_NODE_ID,
  RESUMABLE_TASK_STATUSES,
  WorkflowDefinitionSchema,
  allowedFromStatusesForEvent,
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
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import {
  loadRollbackTargetFrom,
  rollbackNodeRunWorktrees,
  snapshotMissingDetail,
} from '@/services/nodeRollback'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { killStaleRunProcessTree, type StaleRunKillOutcome } from '@/util/process'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../application/drive/taskDriveCoordinator'
import {
  resolveTaskDriveConfig,
  type TaskDriveCompletionMode,
} from '../application/drive/taskDriveTypes'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import type { ChildTaskLifecycleParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { ProviderTaskExecutionModule } from '../composition'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { taskStopProjection } from '../domain/sourceTermination'
import { DrizzleTaskRollbackQueries } from './taskRollbackQueries'
import { createTaskDriverLifecyclePort } from './taskDriverLifecycle'
import { submitTaskContinuation } from './taskContinuationAdmission'
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'
import { withSerializableTaskExecution } from './postgresqlTaskLifecycleTransaction'
import { assertTaskOwnerlessTx } from './ownedTaskExecution'
import { appendTaskLifecycleTransitionCommittedEvent } from './taskLifecycleCommittedEvents'
import { selectResumeRollbackTargets } from '../application/resumeRollbackTargets'
import { reserveTaskReviewMutationSlot } from '@/services/reviewMutationCoordinator'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ActiveTaskExecutionParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskDriverLifecyclePort } from '../application/drive/taskDriveCoordinator'

const NODE_CANCELABLE_STATUSES = allowedFromStatusesForEvent({ kind: 'mark-canceled' })

const log = createLogger('task-execution.postgresql-child-lifecycle')

function lacksMaterializedWorkspace(path: string): boolean {
  return path.length === 0 || !existsSync(path)
}

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
  readonly db: ProviderNeutralDatabase
  readonly persistence: TaskExecutionPersistence
  readonly executionModule: ProviderTaskExecutionModule
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  /** Source-control selected finalizer for a terminal workspace-prune claim. */
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly log: TaskExecutionTopologyLogger
}

/**
 * RFC-359 AC-1（第 10 刀）—— `resume` 这条路**唯一**需要的依赖面。
 *
 * 比上面那份参与者依赖窄两样，而且窄得有道理：
 *   · `executionModule` 只被两处用到——准入门里的「进程内是不是已经有人在跑」，
 *     以及生命周期端口的认领。前者收成 `activity` 端口（第 5 刀立的那个，
 *     两个引擎各自注入自己的注册表）；后者整个收进 `lifecycle`。
 *   · `finalizeWorkspace` 同理，只被 `lifecycle` 用到。
 *
 * `lifecycle` 正是**两个引擎唯一真差异**的容身处：SQLite 走进程级单例的同步认领
 * （`createDatabaseTaskDriverLifecyclePort`），PostgreSQL 走持久化租约认领
 * （`claimPersisted`）。那是两种部署形态的真实差别、不是欠账，所以它该是端口而不是分支。
 * 收窄之后 `server.ts` 那条**不装配完整 runtime** 的路也接得上同一份实现
 *（与第 9 刀给 `retry` 做的收窄同形）。
 */
export interface TaskResumeDependencies {
  readonly db: ProviderNeutralDatabase
  readonly persistence: TaskExecutionPersistence
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  readonly log: TaskExecutionTopologyLogger
  readonly activity: ActiveTaskExecutionParticipant
  readonly lifecycle: TaskDriverLifecyclePort
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

async function loadResumeTask(db: ProviderNeutralDatabase, taskId: string): Promise<ResumeTask> {
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
  dependencies: TaskResumeDependencies,
  task: ResumeTask,
): Promise<void> {
  if (dependencies.activity.isActive(task.id)) {
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
  if (phase === 'pruned' || lacksMaterializedWorkspace(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `task '${task.id}' worktree is unavailable; cannot resume`,
      410,
    )
  }
  const rollbackTarget = await new DrizzleTaskRollbackQueries(dependencies.db).load(task.id)
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
  dependencies: TaskResumeDependencies,
  task: ResumeTask,
  actorUserId: string | undefined,
): Promise<{
  readonly intentId: string
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}> {
  const intentId = ulid()
  const now = Date.now()
  const eventRefs = await withSerializableTaskExecution(dependencies.db, async (tx) => {
    await assertTaskOwnerlessTx(tx, task.id)
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
    await submitTaskContinuation(tx, {
      taskId: task.id,
      intentId,
      kind: 'resume',
      source: actorUserId === undefined ? 'internal' : 'rest',
      actorUserId: actorUserId ?? null,
      payload: { v: 1, event: 'resume' },
      now,
      advanceOperationGeneration: true,
    })
    const eventRef = await appendTaskLifecycleTransitionCommittedEvent(tx, {
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
  dependencies: TaskResumeDependencies,
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
  dependencies: TaskResumeDependencies,
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
  dependencies: TaskResumeDependencies,
  input: {
    readonly taskId: string
    readonly executionContext: Parameters<
      TaskExecutionPersistence['runtimeLifecycle']['trySet']
    >[0]['executionContext']
  },
): Promise<void> {
  const rollbackTarget = await loadRollbackTargetFrom(
    new DrizzleTaskRollbackQueries(dependencies.db),
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
    const missing = snapshotMissingDetail(outcome)
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
    const missing = snapshotMissingDetail(outcome)
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
  // RFC-359 AC-1（第 11 刀第 1 步照出的真分叉）：**取消与评审写入共用任务级 FIFO**。
  //
  // 契约是 `review-cancel-concurrency` 的 `cancel first …` / `… first` 两组锁的那一条：
  // 取消在函数入口**同步取号**（`reserveTaskReviewMutationSlot`，取号与入队之间不许有 await），
  // 之后才 await 自己的前置读；少了取号，取消就会插到一个正在进行的评审写入中间。
  //
  // 这一侧此前**整个没有取号**。后果是用户可见的：PostgreSQL 部署上，一边提交评审决定、
  // 一边点取消，两者的落库会交错——而 SQLite 上取消老老实实排在后面。
  // 那份既有判据虽然跑两个引擎，但两条 lane 调的都是 `cancelTask`（另一侧的实现），
  // 于是这一侧从来没被它验过（`rfc359-w11-cancel-parity` 的 H 格补上了这一维，
  // 加进去时 postgresql lane 当场红）。
  //
  // 槽的覆盖面与另一侧**逐字对齐**：只包住准入与落库那一段；停运行时与级联子任务在槽外
  //（前者要等最多 5s，后者取的是子任务自己的槽）。
  const acquireMutationSlot = reserveTaskReviewMutationSlot(taskId)
  let stopToken = dependencies.executionModule.runtimeRegistry.tokenForTask(taskId)
  let revokedRevision: number | null = null
  const committed = await acquireMutationSlot(async () =>
    withSerializableTaskExecution(dependencies.db, async (tx) => {
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
      if (task === undefined)
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
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
      await terminalizeTaskExecutionIntentsInTx(tx, {
        taskId,
        state: 'canceled',
        failureCode: projection.code,
        now,
      })
      const childIds = (
        await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(eq(tasks.parentTaskId, taskId), inArray(tasks.status, CANCELABLE_TASK_STATUSES)),
          )
      ).map((child) => child.id)
      const eventRef = await appendTaskLifecycleTransitionCommittedEvent(tx, {
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
    }),
  )
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
  const lifecycle = createTaskDriverLifecyclePort({
    db: dependencies.db,
    module: dependencies.executionModule,
    claim: (intentId) => dependencies.executionModule.claimPersisted({ intentId }),
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
      await resumeTaskProjection(
        {
          db: dependencies.db,
          persistence: dependencies.persistence,
          runtimeSessionLeases: dependencies.runtimeSessionLeases,
          log: dependencies.log,
          // 这一侧的「进程内是不是已经有人在跑」读的是 PG 运行时注册表；SQLite 那一侧
          // 注入的是 legacy 进程注册表（`composeLegacyTaskActivityParticipant`）。
          // 同一个角色、两份注册表——正是 `activity` 这个端口存在的理由。
          activity: {
            isActive: (taskId: string) =>
              dependencies.executionModule.runtimeRegistry.hasTask(taskId),
            awaitReleasedSettled: async () => {},
          },
          lifecycle,
        },
        input,
        topology,
      )
    },
  })
}

/**
 * RFC-359 AC-1（第 10 刀）—— `resume` 的**唯一**实现，两个 provider 共用。
 *
 * 等价性由 `rfc359-w10-resume-admission-parity` 的九格对拍作证（合并前实测：八格逐字相同，
 * 第九格是「工作区回收中」的归因差异，合并收敛到本实现这一侧——它说得出「正在被 GC 回收」，
 * 退役那份只能给一个听起来像永久性的 `task-not-resumable`）。
 */
export async function resumeTaskProjection(
  dependencies: TaskResumeDependencies,
  input: Parameters<ChildTaskLifecycleParticipant['resume']>[0],
  topology: Parameters<ChildTaskLifecycleParticipant['resume']>[1],
  /**
   * 收尾模式。**生产一律不传**（`background`：复活是 fire-and-forget，路由立刻把任务行还给调用方）。
   * 只有需要「等引擎跑完再断言」的判据传 `await-settle`——退役那份实现里这件事由
   * `StartTaskDeps.awaitScheduler` 表达，那是 legacy 启动依赖上的一格，共用实现不该认识它，
   * 所以它在这里变成一个显式参数。
   */
  options: { readonly completionMode?: TaskDriveCompletionMode } = {},
): Promise<void> {
  const lifecycle = dependencies.lifecycle
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
    completionMode: options.completionMode ?? 'background',
  })
}
