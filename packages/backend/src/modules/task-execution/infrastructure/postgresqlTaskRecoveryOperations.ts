import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  clarifyRounds,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  recoveryEvents,
  runtimeSessionLeases,
  taskCollaborators,
  taskExecutionIntents,
  taskQuestions,
  tasks,
  users,
} from '@/db/schema'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  CANCELABLE_TASK_STATUSES,
  DAEMON_RESTART_ERROR_SUMMARY,
  REPO_PREP_NODE_ID,
  TERMINAL_NODE_RUN_STATUSES,
} from '@agent-workflow/shared'
import type {
  RecordTaskRecoveryEventInput,
  TaskLifecycleAlertRecord,
  TaskLifecycleAlertReconciliation,
  TaskLifecycleInvariantScope,
  TaskLifecycleInvariantSnapshot,
  TaskRecoveryAutoResumeCandidate,
  TaskRecoveryBootSnapshot,
  TaskRecoveryEventRecord,
  TaskRecoveryOperations,
  TaskRecoveryPeriodicSnapshot,
  TaskRecoveryQuestionParkEntry,
  TaskRecoveryQuestionRunLineage,
  TaskRecoveryRunRecord,
  TaskRecoveryStuckTaskSnapshot,
} from '../application/ports/taskRecoveryOperations'
import { hasUndispatchedDesignerRecoveryEvidence } from '../application/ports/taskRecoveryOperations'
import { isLegacyTaskGateContinuationPayload } from '../domain/humanGateContinuation'
import { PostgresqlNodeRunLifecyclePersistence } from './postgresqlNodeRunLifecyclePersistence'
import { PostgresqlTaskRuntimeLifecyclePersistence } from './postgresqlTaskRuntimeLifecyclePersistence'
import { terminalizePostgresqlTaskExecutionIntentsTx } from './postgresqlTaskExecutionIntentTerminalPersistence'

const CLARIFY_RERUN_CAUSES = ['clarify-answer', 'cross-clarify-questioner-rerun'] as const
const TERMINAL_NODE_RUN_SET: ReadonlySet<string> = new Set(TERMINAL_NODE_RUN_STATUSES)
const LIFECYCLE_INVARIANT_QUERY_CHUNK_SIZE = 400

function chunksOf<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}

function rowsByTask<T extends { readonly taskId: string }>(
  rows: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const taskRows = grouped.get(row.taskId)
    if (taskRows === undefined) grouped.set(row.taskId, [row])
    else taskRows.push(row)
  }
  return grouped
}

function runProjection(row: {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: string
  readonly pid: number | null
  readonly startedAt: number | null
  readonly spawnBinaryPath: string | null
  readonly spawnLaunchNonce: string | null
  readonly parentNodeRunId: string | null
  readonly childTaskId: string | null
}): TaskRecoveryRunRecord {
  return Object.freeze({ ...row })
}

async function latestEventTsForRun(
  db: PostgresqlDatabaseClient,
  nodeRunId: string,
): Promise<number | null> {
  const row = await db
    .select({ ts: nodeRunEvents.ts })
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(desc(nodeRunEvents.id))
    .limit(1)
    .get()
  return row?.ts ?? null
}

async function latestEventTsForTask(
  db: PostgresqlDatabaseClient,
  taskId: string,
): Promise<number | null> {
  const runs = await db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  let latest: number | null = null
  for (const run of runs) {
    const ts = await latestEventTsForRun(db, run.id)
    if (ts !== null && (latest === null || ts > latest)) latest = ts
  }
  return latest
}

async function hasUndispatchedDesignerQuestions(
  db: PostgresqlDatabaseClient,
  taskId: string,
): Promise<boolean> {
  const projection = {
    dispatchedAt: taskQuestions.dispatchedAt,
    triggerRunId: taskQuestions.triggerRunId,
    defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
    overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
  }
  const clarifyDesigner = await db
    .select(projection)
    .from(taskQuestions)
    .innerJoin(
      clarifyRounds,
      eq(taskQuestions.originNodeRunId, clarifyRounds.intermediaryNodeRunId),
    )
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        ne(taskQuestions.confirmation, 'confirmed'),
        eq(clarifyRounds.status, 'answered'),
        eq(clarifyRounds.directive, 'continue'),
      ),
    )
  const manualDesigner = await db
    .select(projection)
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        eq(taskQuestions.sourceKind, 'manual'),
        ne(taskQuestions.confirmation, 'confirmed'),
      ),
    )
  const entries: readonly TaskRecoveryQuestionParkEntry[] = [...clarifyDesigner, ...manualDesigner]
  if (entries.length === 0) return false
  const runs = await db
    .select({
      id: nodeRuns.id,
      nodeId: nodeRuns.nodeId,
      iteration: nodeRuns.iteration,
      rerunCause: nodeRuns.rerunCause,
      status: nodeRuns.status,
      startedAt: nodeRuns.startedAt,
      parentNodeRunId: nodeRuns.parentNodeRunId,
      shardKey: nodeRuns.shardKey,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  const outputRows =
    runs.length === 0
      ? []
      : await db
          .select({ nodeRunId: nodeRunOutputs.nodeRunId })
          .from(nodeRunOutputs)
          .where(
            inArray(
              nodeRunOutputs.nodeRunId,
              runs.map((run) => run.id),
            ),
          )
  const outputRunIds = new Set(outputRows.map((row) => row.nodeRunId))
  const lineage: readonly TaskRecoveryQuestionRunLineage[] = runs.map((run) => ({
    id: run.id,
    nodeId: run.nodeId,
    iteration: run.iteration,
    loopIter: 0,
    rerunCause: run.rerunCause,
    status: run.status,
    startedAt: run.startedAt,
    hasOutput: outputRunIds.has(run.id),
    parentNodeRunId: run.parentNodeRunId,
    shardKey: run.shardKey,
  }))
  return hasUndispatchedDesignerRecoveryEvidence({ entries, runs: lineage })
}

async function loadLifecycleInvariantSnapshots(
  db: PostgresqlDatabaseClient,
  scope: TaskLifecycleInvariantScope,
): Promise<readonly TaskLifecycleInvariantSnapshot[]> {
  const taskRows =
    'taskId' in scope
      ? await db
          .select({
            taskId: tasks.id,
            taskStatus: tasks.status,
            workflowSnapshot: tasks.workflowSnapshot,
          })
          .from(tasks)
          .where(eq(tasks.id, scope.taskId))
      : await db
          .select({
            taskId: tasks.id,
            taskStatus: tasks.status,
            workflowSnapshot: tasks.workflowSnapshot,
          })
          .from(tasks)
          .where(
            'since' in scope
              ? and(
                  isNull(tasks.deletedAt),
                  or(
                    gte(tasks.startedAt, scope.since),
                    gte(tasks.finishedAt, scope.since),
                    isNull(tasks.finishedAt),
                  ),
                )
              : isNull(tasks.deletedAt),
          )
  const snapshots: TaskLifecycleInvariantSnapshot[] = []
  for (const taskChunk of chunksOf(taskRows, LIFECYCLE_INVARIANT_QUERY_CHUNK_SIZE)) {
    const taskIds = taskChunk.map((task) => task.taskId)
    const [documentVersions, roundRows, runRows, questionRows] = await Promise.all([
      db
        .select({
          taskId: docVersions.taskId,
          id: docVersions.id,
          reviewNodeRunId: docVersions.reviewNodeRunId,
          reviewNodeId: docVersions.reviewNodeId,
          versionIndex: docVersions.versionIndex,
          decision: docVersions.decision,
        })
        .from(docVersions)
        .where(inArray(docVersions.taskId, taskIds)),
      db
        .select({
          taskId: clarifyRounds.taskId,
          id: clarifyRounds.id,
          kind: clarifyRounds.kind,
          status: clarifyRounds.status,
          directive: clarifyRounds.directive,
          clarifyNodeRunId: clarifyRounds.intermediaryNodeRunId,
          clarifyNodeId: clarifyRounds.intermediaryNodeId,
        })
        .from(clarifyRounds)
        .where(inArray(clarifyRounds.taskId, taskIds)),
      db
        .select({
          taskId: nodeRuns.taskId,
          id: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          iteration: nodeRuns.iteration,
          rerunCause: nodeRuns.rerunCause,
          startedAt: nodeRuns.startedAt,
          parentNodeRunId: nodeRuns.parentNodeRunId,
          reviewIteration: nodeRuns.reviewIteration,
          shardKey: nodeRuns.shardKey,
        })
        .from(nodeRuns)
        .where(inArray(nodeRuns.taskId, taskIds)),
      db
        .select({
          taskId: taskQuestions.taskId,
          originNodeRunId: taskQuestions.originNodeRunId,
          sourceKind: taskQuestions.sourceKind,
          roleKind: taskQuestions.roleKind,
          confirmation: taskQuestions.confirmation,
          dispatchedAt: taskQuestions.dispatchedAt,
          triggerRunId: taskQuestions.triggerRunId,
          defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
          overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
        })
        .from(taskQuestions)
        .where(inArray(taskQuestions.taskId, taskIds)),
    ])
    const outputRows: { readonly nodeRunId: string }[] = []
    for (const runIdChunk of chunksOf(
      runRows.map((run) => run.id),
      LIFECYCLE_INVARIANT_QUERY_CHUNK_SIZE,
    )) {
      outputRows.push(
        ...(await db
          .select({ nodeRunId: nodeRunOutputs.nodeRunId })
          .from(nodeRunOutputs)
          .where(inArray(nodeRunOutputs.nodeRunId, runIdChunk))),
      )
    }
    const documentsByTask = rowsByTask(documentVersions)
    const roundsByTask = rowsByTask(roundRows)
    const runsByTask = rowsByTask(runRows)
    const questionsByTask = rowsByTask(questionRows)
    const outputRunIds = new Set(outputRows.map((row) => row.nodeRunId))
    for (const task of taskChunk) {
      const taskRounds = roundsByTask.get(task.taskId) ?? []
      const answeredContinueRoundIds = new Set(
        taskRounds
          .filter((round) => round.status === 'answered' && round.directive === 'continue')
          .map((round) => round.clarifyNodeRunId),
      )
      const taskQuestionsForRecovery = questionsByTask.get(task.taskId) ?? []
      const toEntry = (
        question: (typeof taskQuestionsForRecovery)[number],
      ): TaskRecoveryQuestionParkEntry => ({
        dispatchedAt: question.dispatchedAt,
        triggerRunId: question.triggerRunId,
        defaultTargetNodeId: question.defaultTargetNodeId,
        overrideTargetNodeId: question.overrideTargetNodeId,
      })
      const entries: readonly TaskRecoveryQuestionParkEntry[] = [
        ...taskQuestionsForRecovery
          .filter(
            (question) =>
              question.roleKind === 'designer' &&
              question.confirmation !== 'confirmed' &&
              answeredContinueRoundIds.has(question.originNodeRunId),
          )
          .map(toEntry),
        ...taskQuestionsForRecovery
          .filter(
            (question) =>
              question.roleKind === 'designer' &&
              question.sourceKind === 'manual' &&
              question.confirmation !== 'confirmed',
          )
          .map(toEntry),
      ]
      const taskRuns = runsByTask.get(task.taskId) ?? []
      const lineage: readonly TaskRecoveryQuestionRunLineage[] = taskRuns.map((run) => ({
        id: run.id,
        nodeId: run.nodeId,
        iteration: run.iteration,
        loopIter: 0,
        rerunCause: run.rerunCause,
        status: run.status,
        startedAt: run.startedAt,
        hasOutput: outputRunIds.has(run.id),
        parentNodeRunId: run.parentNodeRunId,
        shardKey: run.shardKey,
      }))
      snapshots.push(
        Object.freeze({
          ...task,
          hasUndispatchedDesignerQuestions: hasUndispatchedDesignerRecoveryEvidence({
            entries,
            runs: lineage,
          }),
          documentVersions: Object.freeze(
            (documentsByTask.get(task.taskId) ?? []).map(({ taskId: _taskId, ...row }) =>
              Object.freeze(row),
            ),
          ),
          clarifyRounds: Object.freeze(
            taskRounds.map(({ taskId: _taskId, directive: _directive, ...row }) =>
              Object.freeze(row),
            ),
          ),
          nodeRuns: Object.freeze(
            taskRuns.map(
              ({
                taskId: _taskId,
                iteration: _iteration,
                rerunCause: _rerunCause,
                startedAt: _startedAt,
                ...row
              }) => Object.freeze(row),
            ),
          ),
        }),
      )
    }
  }
  return Object.freeze(snapshots)
}

async function hasNoActiveHumanMember(
  db: PostgresqlDatabaseClient,
  taskId: string,
  ownerUserId: string | null,
): Promise<boolean> {
  const collaborators = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  const memberIds = [
    ...new Set([
      ...(ownerUserId !== null && ownerUserId !== SYSTEM_USER_ID ? [ownerUserId] : []),
      ...collaborators
        .filter((collaborator) => collaborator.role === 'collaborator')
        .map((collaborator) => collaborator.userId),
    ]),
  ]
  if (memberIds.length === 0) return false
  const active = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, memberIds), eq(users.status, 'active')))
    .limit(1)
    .get()
  return active === undefined
}

async function loadStuckTaskSnapshots(
  db: PostgresqlDatabaseClient,
  taskIdFilter?: readonly string[],
): Promise<readonly TaskRecoveryStuckTaskSnapshot[]> {
  const base = and(isNull(tasks.deletedAt), inArray(tasks.status, [...CANCELABLE_TASK_STATUSES]))
  const rows = await db
    .select({
      taskId: tasks.id,
      parentTaskId: tasks.parentTaskId,
      status: tasks.status,
      startedAt: tasks.startedAt,
      ownerUserId: tasks.ownerUserId,
      workgroupId: tasks.workgroupId,
      worktreePath: tasks.worktreePath,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePrunedAt: tasks.workspacePrunedAt,
      workflowSnapshot: tasks.workflowSnapshot,
    })
    .from(tasks)
    .where(
      taskIdFilter === undefined || taskIdFilter.length === 0
        ? base
        : and(base, inArray(tasks.id, [...taskIdFilter])),
    )
  const prepIds =
    rows.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ taskId: nodeRuns.taskId })
              .from(nodeRuns)
              .where(
                and(
                  inArray(
                    nodeRuns.taskId,
                    rows.map((row) => row.taskId),
                  ),
                  eq(nodeRuns.nodeId, REPO_PREP_NODE_ID),
                ),
              )
              .groupBy(nodeRuns.taskId)
          ).map((row) => row.taskId),
        )
  const snapshots: TaskRecoveryStuckTaskSnapshot[] = []
  for (const row of rows) {
    const runRows = await db
      .select({
        id: nodeRuns.id,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        pid: nodeRuns.pid,
        childTaskId: nodeRuns.childTaskId,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, row.taskId))
    const stuckRuns = []
    let latestTaskEventTs: number | null = null
    for (const run of runRows) {
      const lastEventTs = await latestEventTsForRun(db, run.id)
      if (lastEventTs !== null && (latestTaskEventTs === null || lastEventTs > latestTaskEventTs)) {
        latestTaskEventTs = lastEventTs
      }
      let child: TaskRecoveryStuckTaskSnapshot['runs'][number]['child'] = null
      if (run.childTaskId !== null) {
        const childRow = await db
          .select({ status: tasks.status, startedAt: tasks.startedAt })
          .from(tasks)
          .where(eq(tasks.id, run.childTaskId))
          .limit(1)
          .get()
        if (childRow !== undefined) {
          child = {
            status: childRow.status,
            startedAt: childRow.startedAt,
            lastEventTs: await latestEventTsForTask(db, run.childTaskId),
          }
        }
      }
      stuckRuns.push({ ...run, lastEventTs, child })
    }
    const [pendingDoc, openClarify, undispatchedDesigner, noActiveMember] = await Promise.all([
      db
        .select({ id: docVersions.id })
        .from(docVersions)
        .where(and(eq(docVersions.taskId, row.taskId), eq(docVersions.decision, 'pending')))
        .limit(1)
        .get(),
      db
        .select({ id: clarifyRounds.id })
        .from(clarifyRounds)
        .where(
          and(eq(clarifyRounds.taskId, row.taskId), eq(clarifyRounds.status, 'awaiting_human')),
        )
        .limit(1)
        .get(),
      hasUndispatchedDesignerQuestions(db, row.taskId),
      hasNoActiveHumanMember(db, row.taskId, row.ownerUserId),
    ])
    snapshots.push(
      Object.freeze({
        ...row,
        hasRepoPrepRow: prepIds.has(row.taskId),
        latestEventTs: latestTaskEventTs,
        hasPendingDocVersion: pendingDoc !== undefined,
        hasOpenClarifySession: openClarify !== undefined,
        hasUndispatchedDesignerQuestions: undispatchedDesigner,
        hasNoActiveHumanMember: noActiveMember,
        runs: Object.freeze(stuckRuns),
      }),
    )
  }
  return Object.freeze(snapshots)
}

export function createPostgresqlTaskRecoveryOperations(
  db: PostgresqlDatabaseClient,
): TaskRecoveryOperations {
  const nodeLifecycle = new PostgresqlNodeRunLifecyclePersistence(db)
  const taskLifecycle = new PostgresqlTaskRuntimeLifecyclePersistence(db)
  const operations: TaskRecoveryOperations = {
    async recordEvent(input: RecordTaskRecoveryEventInput): Promise<void> {
      await db.insert(recoveryEvents).values(input).run()
    },

    async listEventsForTask(
      taskId: string,
      limit: number,
    ): Promise<readonly TaskRecoveryEventRecord[]> {
      return db
        .select()
        .from(recoveryEvents)
        .where(eq(recoveryEvents.taskId, taskId))
        .orderBy(desc(recoveryEvents.createdAt))
        .limit(limit)
        .all()
    },

    async isAutoRecoverySuspended(taskId: string): Promise<boolean> {
      const row = await db
        .select({ suspended: tasks.autoRecoverySuspended })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
        .get()
      return row?.suspended ?? false
    },

    async recordAutoRecoveryAttempt(input) {
      return db.transaction(async (tx) => {
        const row = await tx
          .select({
            attempts: tasks.autoRecoveryAttempts,
            windowStart: tasks.autoRecoveryWindowStartedAt,
            suspended: tasks.autoRecoverySuspended,
          })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .get()
        if (row === undefined) return { suspended: false, attempts: 0 }
        if (row.suspended) return { suspended: true, attempts: row.attempts }

        const reset =
          row.windowStart === null || input.now - row.windowStart >= input.config.windowMs
        const windowStart = reset ? input.now : row.windowStart
        const attempts = reset ? 1 : row.attempts + 1
        const suspended = attempts > input.config.maxPerWindow
        await tx
          .update(tasks)
          .set({
            autoRecoveryAttempts: attempts,
            autoRecoveryWindowStartedAt: windowStart,
            autoRecoverySuspended: suspended,
          })
          .where(eq(tasks.id, input.taskId))
          .run()
        return { suspended, attempts }
      })
    },

    async clearAutoRecoverySuspension(taskId: string): Promise<void> {
      await db
        .update(tasks)
        .set({
          autoRecoverySuspended: false,
          autoRecoveryAttempts: 0,
          autoRecoveryWindowStartedAt: null,
        })
        .where(eq(tasks.id, taskId))
        .run()
    },

    async listOpenLifecycleAlerts(taskId?: string): Promise<readonly TaskLifecycleAlertRecord[]> {
      const predicate =
        taskId === undefined
          ? isNull(lifecycleAlerts.resolvedAt)
          : and(eq(lifecycleAlerts.taskId, taskId), isNull(lifecycleAlerts.resolvedAt))
      return db
        .select({
          id: lifecycleAlerts.id,
          taskId: lifecycleAlerts.taskId,
          rule: lifecycleAlerts.rule,
          severity: lifecycleAlerts.severity,
          detail: lifecycleAlerts.detail,
          detectedAt: lifecycleAlerts.detectedAt,
        })
        .from(lifecycleAlerts)
        .where(predicate)
        .orderBy(asc(lifecycleAlerts.detectedAt))
        .all()
    },

    async taskIdsWithRepoPrepRow(taskIds: readonly string[]): Promise<ReadonlySet<string>> {
      if (taskIds.length === 0) return new Set()
      const rows = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(and(inArray(nodeRuns.taskId, [...taskIds]), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
        .groupBy(nodeRuns.taskId)
        .limit(taskIds.length)
        .all()
      return new Set(rows.map((row) => row.taskId))
    },

    async listStalledRunningChildren(input) {
      const runs = await db
        .select({
          id: nodeRuns.id,
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          pid: nodeRuns.pid,
          startedAt: nodeRuns.startedAt,
          spawnBinaryPath: nodeRuns.spawnBinaryPath,
          spawnLaunchNonce: nodeRuns.spawnLaunchNonce,
          parentNodeRunId: nodeRuns.parentNodeRunId,
          containerRunId: nodeRuns.containerRunId,
          childTaskId: nodeRuns.childTaskId,
        })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.status, 'running'), isNotNull(nodeRuns.pid)))
      const cutoff = input.now - input.stallMs
      const stalled: TaskRecoveryRunRecord[] = []
      for (const run of runs) {
        const events = await db
          .select({ ts: nodeRunEvents.ts })
          .from(nodeRunEvents)
          .where(eq(nodeRunEvents.nodeRunId, run.id))
          .orderBy(desc(nodeRunEvents.id))
          .limit(input.eventWindowRows)
        let lastEventTs: number | null = null
        for (const event of events) {
          if (lastEventTs === null || event.ts > lastEventTs) lastEventTs = event.ts
        }
        if ((lastEventTs ?? run.startedAt ?? 0) < cutoff) {
          stalled.push(Object.freeze({ ...runProjection(run), lastEventTs }))
        }
      }
      return Object.freeze(stalled)
    },

    async listAutoResumeCandidates(): Promise<readonly TaskRecoveryAutoResumeCandidate[]> {
      const projection = {
        id: tasks.id,
        workgroupId: tasks.workgroupId,
        workgroupConfigJson: tasks.workgroupConfigJson,
        worktreePath: tasks.worktreePath,
        workspacePruningAt: tasks.workspacePruningAt,
        workspacePrunedAt: tasks.workspacePrunedAt,
      }
      const interrupted = await db
        .select(projection)
        .from(tasks)
        .where(
          and(
            eq(tasks.status, 'interrupted'),
            eq(tasks.errorSummary, DAEMON_RESTART_ERROR_SUMMARY),
          ),
        )
      const wedged = await db
        .select(projection)
        .from(tasks)
        .innerJoin(nodeRuns, eq(nodeRuns.taskId, tasks.id))
        .where(
          and(
            eq(tasks.status, 'awaiting_human'),
            eq(nodeRuns.status, 'interrupted'),
            inArray(nodeRuns.rerunCause, [...CLARIFY_RERUN_CAUSES]),
          ),
        )
      const byId = new Map<string, TaskRecoveryAutoResumeCandidate>()
      for (const row of interrupted) byId.set(row.id, Object.freeze({ ...row }))
      for (const row of wedged) {
        if (!byId.has(row.id)) byId.set(row.id, Object.freeze({ ...row }))
      }
      return Object.freeze([...byId.values()])
    },

    async loadBootOrphanSnapshot(): Promise<TaskRecoveryBootSnapshot> {
      const taskCandidates = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(inArray(tasks.status, ['running', 'pending']))
      const runProjectionFields = {
        id: nodeRuns.id,
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        pid: nodeRuns.pid,
        startedAt: nodeRuns.startedAt,
        spawnBinaryPath: nodeRuns.spawnBinaryPath,
        spawnLaunchNonce: nodeRuns.spawnLaunchNonce,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        containerRunId: nodeRuns.containerRunId,
        childTaskId: nodeRuns.childTaskId,
      }
      const runCandidates = await db
        .select(runProjectionFields)
        .from(nodeRuns)
        .where(inArray(nodeRuns.status, ['running', 'pending']))
      const pendingContinuations = await db
        .select({
          taskId: taskExecutionIntents.taskId,
          payloadJson: taskExecutionIntents.payloadJson,
        })
        .from(taskExecutionIntents)
        .where(
          and(
            eq(taskExecutionIntents.kind, 'gate-continuation'),
            eq(taskExecutionIntents.state, 'pending'),
          ),
        )
      const preservedTaskIds = new Set(
        pendingContinuations
          .filter((row) => !isLegacyTaskGateContinuationPayload(row.payloadJson))
          .map((row) => row.taskId),
      )
      const bootTasks = taskCandidates
        .filter(
          (task): task is { id: string; status: 'running' | 'pending' } =>
            (task.status === 'running' || task.status === 'pending') &&
            !(task.status === 'pending' && preservedTaskIds.has(task.id)),
        )
        .map((task) => Object.freeze({ ...task }))
      const bootRuns = runCandidates
        .filter((run) => !(run.status === 'pending' && preservedTaskIds.has(run.taskId)))
        .map(runProjection)
      const heldLeaseRunIds = [
        ...new Set(
          (
            await db
              .select({ nodeRunId: runtimeSessionLeases.leaseNodeRunId })
              .from(runtimeSessionLeases)
              .where(isNotNull(runtimeSessionLeases.leaseNodeRunId))
          ).flatMap((row) => (row.nodeRunId === null ? [] : [row.nodeRunId])),
        ),
      ]
      const heldLeaseRuns =
        heldLeaseRunIds.length === 0
          ? []
          : (
              await db
                .select(runProjectionFields)
                .from(nodeRuns)
                .where(inArray(nodeRuns.id, heldLeaseRunIds))
            ).map(runProjection)
      return Object.freeze({
        tasks: Object.freeze(bootTasks),
        runs: Object.freeze(bootRuns),
        heldLeaseRunIds: Object.freeze(heldLeaseRunIds),
        heldLeaseRuns: Object.freeze(heldLeaseRuns),
      })
    },

    async interruptBootOrphanTask(input): Promise<boolean> {
      return await taskLifecycle.trySetWithGuard(
        {
          taskId: input.taskId,
          to: 'interrupted',
          allowedFrom: [input.from],
          extra: {
            finishedAt: input.now,
            errorSummary: input.failureCode,
            errorMessage: input.errorMessage,
          },
          now: input.now,
          reason: 'reapOrphanRuns',
        },
        (tx) =>
          terminalizePostgresqlTaskExecutionIntentsTx(tx, {
            taskId: input.taskId,
            state: 'failed',
            failureCode: input.failureCode,
            now: input.now,
          }),
      )
    },

    async interruptNodeRun(input): Promise<boolean> {
      try {
        await nodeLifecycle.transition({
          nodeRunId: input.nodeRunId,
          event: { kind: 'mark-interrupted' },
          extra: {
            finishedAt: input.now,
            ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
          },
        })
        return true
      } catch {
        return false
      }
    },

    async listPeriodicReconcileCandidates(startedBefore: number) {
      const rows = await db
        .select({
          id: nodeRuns.id,
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          pid: nodeRuns.pid,
          startedAt: nodeRuns.startedAt,
          spawnBinaryPath: nodeRuns.spawnBinaryPath,
          spawnLaunchNonce: nodeRuns.spawnLaunchNonce,
          parentNodeRunId: nodeRuns.parentNodeRunId,
          containerRunId: nodeRuns.containerRunId,
          childTaskId: nodeRuns.childTaskId,
        })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.status, 'running'), lt(nodeRuns.startedAt, startedBefore)))
      return Object.freeze(rows.map(runProjection))
    },

    async loadPeriodicReconcileSnapshot(
      taskId: string,
    ): Promise<TaskRecoveryPeriodicSnapshot | null> {
      const task = await db
        .select({ workflowSnapshot: tasks.workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
        .get()
      if (task === undefined) return null
      const rows = await db
        .select({
          id: nodeRuns.id,
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          pid: nodeRuns.pid,
          startedAt: nodeRuns.startedAt,
          spawnBinaryPath: nodeRuns.spawnBinaryPath,
          spawnLaunchNonce: nodeRuns.spawnLaunchNonce,
          parentNodeRunId: nodeRuns.parentNodeRunId,
          containerRunId: nodeRuns.containerRunId,
          childTaskId: nodeRuns.childTaskId,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
      const childIds = [
        ...new Set(rows.flatMap((row) => (row.childTaskId ? [row.childTaskId] : []))),
      ]
      const children =
        childIds.length === 0
          ? []
          : await db
              .select({ id: tasks.id, status: tasks.status })
              .from(tasks)
              .where(inArray(tasks.id, childIds))
      return Object.freeze({
        workflowSnapshot: task.workflowSnapshot,
        runs: Object.freeze(rows.map(runProjection)),
        childTaskStatuses: Object.freeze(
          Object.fromEntries(children.map((child) => [child.id, child.status])),
        ),
      })
    },

    async findHeldRuntimeSessionId(nodeRunId: string): Promise<string | null> {
      const lease = await db
        .select({ sessionId: runtimeSessionLeases.sessionId })
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId))
        .limit(1)
        .get()
      return lease?.sessionId ?? null
    },

    async repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId: string): Promise<number> {
      return await db.transaction(async (tx) => {
        const leases = await tx
          .select()
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId))
        let repaired = 0
        for (const lease of leases) {
          if (lease.leaseNodeRunId === null || lease.leaseNonceDigest === null) continue
          const run = await tx
            .select({
              status: nodeRuns.status,
              sessionId: nodeRuns.opencodeSessionId,
              failureCode: nodeRuns.failureCode,
            })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, lease.leaseNodeRunId))
            .limit(1)
            .get()
          if (run === undefined || !TERMINAL_NODE_RUN_SET.has(run.status)) continue
          const reusable =
            run.failureCode !== 'runtime-session-identity-invalid' &&
            !lease.resetPending &&
            run.sessionId === lease.sessionId
          if (reusable) {
            const released = await tx
              .update(runtimeSessionLeases)
              .set({ leaseNodeRunId: null, leaseNonceDigest: null, leasedAt: null })
              .where(
                and(
                  eq(runtimeSessionLeases.protocol, lease.protocol),
                  eq(runtimeSessionLeases.sessionId, lease.sessionId),
                  eq(runtimeSessionLeases.leaseNodeRunId, lease.leaseNodeRunId),
                  eq(runtimeSessionLeases.leaseNonceDigest, lease.leaseNonceDigest),
                  eq(runtimeSessionLeases.resetPending, false),
                ),
              )
              .returning({ sessionId: runtimeSessionLeases.sessionId })
            if (released[0] !== undefined) repaired += 1
            continue
          }
          await tx
            .update(nodeRuns)
            .set({ opencodeSessionId: null })
            .where(
              and(
                eq(nodeRuns.id, lease.leaseNodeRunId),
                eq(nodeRuns.opencodeSessionId, lease.sessionId),
              ),
            )
            .run()
          const discarded = await tx
            .delete(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, lease.protocol),
                eq(runtimeSessionLeases.sessionId, lease.sessionId),
                eq(runtimeSessionLeases.leaseNodeRunId, lease.leaseNodeRunId),
                eq(runtimeSessionLeases.leaseNonceDigest, lease.leaseNonceDigest),
              ),
            )
            .returning({ sessionId: runtimeSessionLeases.sessionId })
          if (discarded[0] !== undefined) repaired += 1
        }
        return repaired
      })
    },

    async interruptPeriodicTaskIfIdle(input): Promise<boolean> {
      const active = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(eq(nodeRuns.taskId, input.taskId), inArray(nodeRuns.status, ['running', 'pending'])),
        )
        .limit(1)
        .get()
      if (active !== undefined) return false
      return await taskLifecycle.trySet({
        taskId: input.taskId,
        to: 'interrupted',
        allowedFrom: ['running'],
        extra: { finishedAt: input.now, errorSummary: input.failureCode },
        now: input.now,
        reason: 'reconcileDeadRunningRuns',
      })
    },

    loadStuckTaskSnapshots: (taskIdFilter) => loadStuckTaskSnapshots(db, taskIdFilter),
    loadLifecycleInvariantSnapshots: (scope) => loadLifecycleInvariantSnapshots(db, scope),

    async reconcileStuckAlerts(input): Promise<TaskLifecycleAlertReconciliation> {
      const openRows = []
      if (input.taskIds.length > 0 && input.ownedRules.length > 0) {
        for (let offset = 0; offset < input.taskIds.length; offset += 500) {
          const taskIds = input.taskIds.slice(offset, offset + 500)
          openRows.push(
            ...(await db
              .select()
              .from(lifecycleAlerts)
              .where(
                and(
                  inArray(lifecycleAlerts.taskId, taskIds),
                  inArray(lifecycleAlerts.rule, [...input.ownedRules]),
                  isNull(lifecycleAlerts.resolvedAt),
                ),
              )),
          )
        }
      }
      const openByKey = new Map(openRows.map((row) => [`${row.taskId}\u0000${row.rule}`, row]))
      const findingByKey = new Map(
        input.findings.map((finding) => [`${finding.taskId}\u0000${finding.rule}`, finding]),
      )
      let newAlerts = 0
      let promotedAlerts = 0
      let resolvedAlerts = 0
      const openAlerts = []
      const transitions = []
      const resolvedTaskIds = new Set<string>()
      for (const row of openRows) {
        if (findingByKey.has(`${row.taskId}\u0000${row.rule}`)) continue
        await db
          .update(lifecycleAlerts)
          .set({ resolvedAt: input.now })
          .where(eq(lifecycleAlerts.id, row.id))
          .run()
        resolvedAlerts += 1
        resolvedTaskIds.add(row.taskId)
      }
      for (const finding of input.findings) {
        const existing = openByKey.get(`${finding.taskId}\u0000${finding.rule}`)
        if (existing === undefined) {
          const row = Object.freeze({
            id: ulid(),
            taskId: finding.taskId,
            rule: finding.rule,
            severity: 'warning' as const,
            detail: finding.detail,
            detectedAt: input.now,
            resolvedAt: null,
          })
          await db
            .insert(lifecycleAlerts)
            .values({
              id: row.id,
              taskId: row.taskId,
              rule: row.rule,
              severity: row.severity,
              detail: JSON.stringify(row.detail),
              detectedAt: row.detectedAt,
              resolvedAt: null,
            })
            .run()
          newAlerts += 1
          openAlerts.push(row)
          transitions.push(Object.freeze({ row, kind: 'new' as const }))
          continue
        }
        const severity =
          existing.severity === 'warning' &&
          input.now - existing.detectedAt >= input.promotionAfterMs
            ? ('error' as const)
            : (existing.severity as 'warning' | 'error')
        await db
          .update(lifecycleAlerts)
          .set({ severity, detail: JSON.stringify(finding.detail) })
          .where(eq(lifecycleAlerts.id, existing.id))
          .run()
        const row = Object.freeze({
          id: existing.id,
          taskId: finding.taskId,
          rule: finding.rule,
          severity,
          detail: finding.detail,
          detectedAt: existing.detectedAt,
          resolvedAt: null,
        })
        openAlerts.push(row)
        if (severity !== existing.severity) {
          promotedAlerts += 1
          transitions.push(Object.freeze({ row, kind: 'promoted' as const }))
        }
      }
      return Object.freeze({
        newAlerts,
        promotedAlerts,
        resolvedAlerts,
        openAlerts: Object.freeze(openAlerts),
        transitions: Object.freeze(transitions),
        resolvedTaskIds: Object.freeze([...resolvedTaskIds]),
      })
    },
  }
  return Object.freeze(operations)
}
