import { createRunSelectionReader } from './runSelection/table/reader'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { PersistenceTx, PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ConflictError } from '@/util/errors'
import { nodeRunReadColumns } from './nodeRunQueries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskRecoveryHumanGateFactsPort } from '../composition/required-ports'
import { taskReadColumns } from './taskRepositorySql'
// RFC-359 W4-B1 批 2e —— 任务恢复读 / 写：一份实现，两个 provider 共用。
//
// 此前 sqlite / postgresql 两份约千行只差客户端类型、同步 / 异步形态，以及「四条状态迁移」的来源：
// SQLite 由装配面注入、PG 内联自己的 lifecycle 内核。这里取 SQLite 的形状——迁移由各 provider 装配面注入
// （`composition/taskExecutionPersistence.ts`），其余读 / 写共用；`recordAutoRecoveryAttempt` 取 PG 的
// 事务形态（读 + 写同一事务，SQLite 侧此前是两条自动提交语句）。

import { first, queryRows } from '@/platform/persistence/queryHelpers'

import { insertOne } from '@/platform/persistence/singleInsert'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import { taskSubjectFromDefinition } from '../domain/taskSubject'
import { taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'

import {
  CANCELABLE_TASK_STATUSES,
  DAEMON_RESTART_ERROR_SUMMARY,
  REPO_PREP_NODE_ID,
} from '@agent-workflow/shared'
import type {
  RecordTaskRecoveryEventInput,
  TaskLifecycleAlertReconciliation,
  TaskLifecycleAlertRecord,
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
import { isLegacyTaskGateContinuationPayload } from '../domain/humanGateContinuation'
import { resolveHandlerRun } from '../application/resolveHandlerRun'

/** Exact RFC-120 designer-park evidence used by stuck detection. Keeping the
 * lineage partition pure lets both provider adapters expose the same closed
 * boolean without importing Collaboration infrastructure across contexts. */
async function hasUndispatchedDesignerRecoveryEvidence(input: {
  readonly entries: readonly TaskRecoveryQuestionParkEntry[]
  readonly runs: readonly TaskRecoveryQuestionRunLineage[]
}): Promise<boolean> {
  const hasUndispatched = new Set<string>()
  const hasInFlight = new Set<string>()
  for (const entry of input.entries) {
    const target = entry.overrideTargetNodeId ?? entry.defaultTargetNodeId
    if (target === null || target === '') continue
    if (entry.dispatchedAt === null) {
      hasUndispatched.add(target)
      continue
    }
    if (entry.triggerRunId === null) {
      hasInFlight.add(target)
      continue
    }
    const anchor = input.runs.find((run) => run.id === entry.triggerRunId)
    if (anchor === undefined) {
      hasInFlight.add(target)
      continue
    }
    const handler = await resolveHandlerRun({
      effectiveTargetNodeId: anchor.nodeId,
      iteration: anchor.iteration,
      loopIter: anchor.loopIter,
      triggerRunId: entry.triggerRunId,
      runs: [...input.runs],
      ...(anchor.shardKey === null ? {} : { shardKey: anchor.shardKey }),
    })
    if (handler === null || handler.status !== 'done') hasInFlight.add(target)
  }
  for (const target of hasUndispatched) {
    if (!hasInFlight.has(target)) return true
  }
  return false
}

const CLARIFY_RERUN_CAUSES = ['clarify-answer', 'cross-clarify-questioner-rerun'] as const
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

async function latestEventTsForRun(db: PersistenceDb, nodeRunId: string): Promise<number | null> {
  const { nodeRunEvents } = tablesOf(db)
  const row = await first(
    db
      .select({ ts: nodeRunEvents.ts })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .orderBy(desc(nodeRunEvents.id))
      .limit(1),
  )
  return row?.ts ?? null
}

async function latestEventTsForTask(db: PersistenceDb, taskId: string): Promise<number | null> {
  const { nodeRuns } = tablesOf(db)

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
  db: PersistenceDb,
  humanGates: TaskRecoveryHumanGateFactsPort,
  taskId: string,
): Promise<boolean> {
  const { nodeRuns, nodeRunOutputs } = tablesOf(db)

  const entries = await humanGates.designerParkEntries(taskId)
  if (entries.length === 0) return false
  const runs = await db
    .select({
      id: nodeRuns.id,
      seq: nodeRuns.seq,
      nodeId: nodeRuns.nodeId,
      iteration: nodeRuns.iteration,
      rerunCause: nodeRuns.rerunCause,
      status: nodeRuns.status,
      startedAt: nodeRuns.startedAt,
      parentNodeRunId: nodeRuns.historicalParentId,
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
    seq: run.seq,
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
  return await hasUndispatchedDesignerRecoveryEvidence({ entries, runs: lineage })
}

async function loadLifecycleInvariantSnapshots(
  db: PersistenceDb,
  humanGates: TaskRecoveryHumanGateFactsPort,
  scope: TaskLifecycleInvariantScope,
): Promise<readonly TaskLifecycleInvariantSnapshot[]> {
  const { docVersions, taskQuestions } = tablesOf(db)
  const { nodeRuns, nodeRunOutputs } = tablesOf(db)

  const { tasks } = tablesOf(db)
  const taskRows =
    'taskId' in scope
      ? await db
          .select({
            taskId: tasks.id,
            taskStatus: tasks.status,
            workflowSnapshot: taskReadColumns(db).workflowSnapshot,
          })
          .from(tasks)
          .where(eq(tasks.id, scope.taskId))
      : await db
          .select({
            taskId: tasks.id,
            taskStatus: tasks.status,
            workflowSnapshot: taskReadColumns(db).workflowSnapshot,
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
      humanGates.lifecycleClarifyRounds(taskIds),
      db
        .select({
          taskId: nodeRuns.taskId,
          id: nodeRuns.id,
          seq: nodeRuns.seq,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          iteration: nodeRuns.iteration,
          rerunCause: nodeRuns.rerunCause,
          startedAt: nodeRuns.startedAt,
          parentNodeRunId: nodeRuns.historicalParentId,
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
        seq: run.seq,
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
          hasUndispatchedDesignerQuestions: await hasUndispatchedDesignerRecoveryEvidence({
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
  db: PersistenceDb,
  taskId: string,
  ownerUserId: string | null,
): Promise<boolean> {
  const { taskCollaborators, users } = tablesOf(db)
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
  const active = await first(
    db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, memberIds), eq(users.status, 'active')))
      .limit(1),
  )
  return active === undefined
}

async function loadStuckTaskSnapshots(
  db: PersistenceDb,
  humanGates: TaskRecoveryHumanGateFactsPort,
  taskIdFilter?: readonly string[],
): Promise<readonly TaskRecoveryStuckTaskSnapshot[]> {
  const { docVersions } = tablesOf(db)
  const { nodeRuns } = tablesOf(db)
  const nodeRunColumns = nodeRunReadColumns(db)
  const { tasks } = tablesOf(db)
  const base = and(isNull(tasks.deletedAt), inArray(tasks.status, [...CANCELABLE_TASK_STATUSES]))
  const rows = await db
    .select({
      taskId: tasks.id,
      parentTaskId: tasks.parentTaskId,
      status: tasks.status,
      startedAt: tasks.startedAt,
      ownerUserId: tasks.ownerUserId,
      workgroupId: taskReadColumns(db).workgroupId,
      workflowId: taskReadColumns(db).workflowId,
      subjectKind: taskReadColumns(db).subjectKind,
      sourceId: taskReadColumns(db).sourceId,
      sourceName: taskReadColumns(db).sourceName,
      codeRoundId: taskReadColumns(db).codeRoundId,
      sourceAgentId: taskReadColumns(db).sourceAgentId,
      sourceAgentName: taskReadColumns(db).sourceAgentName,
      worktreePath: taskReadColumns(db).worktreePath,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePrunedAt: tasks.workspacePrunedAt,
      workflowSnapshot: taskReadColumns(db).workflowSnapshot,
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
        seq: nodeRuns.seq,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        pid: nodeRunColumns.pid,
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
        const childRow = await first(
          db
            .select({ status: tasks.status, startedAt: tasks.startedAt })
            .from(tasks)
            .where(eq(tasks.id, run.childTaskId))
            .limit(1),
        )
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
      first(
        db
          .select({ id: docVersions.id })
          .from(docVersions)
          .where(and(eq(docVersions.taskId, row.taskId), eq(docVersions.decision, 'pending')))
          .limit(1),
      ),
      humanGates.hasOpenClarifyRound(row.taskId),
      hasUndispatchedDesignerQuestions(db, humanGates, row.taskId),
      hasNoActiveHumanMember(db, row.taskId, row.ownerUserId),
    ])
    snapshots.push(
      Object.freeze({
        ...row,
        subject: taskSubjectFromDefinition(row),
        hasRepoPrepRow: prepIds.has(row.taskId),
        latestEventTs: latestTaskEventTs,
        hasPendingDocVersion: pendingDoc !== undefined,
        hasOpenClarifySession: openClarify,
        hasUndispatchedDesignerQuestions: undispatchedDesigner,
        hasNoActiveHumanMember: noActiveMember,
        runs: Object.freeze(stuckRuns),
      }),
    )
  }
  return Object.freeze(snapshots)
}

/** 四条状态迁移由 provider 装配面注入（各自的 lifecycle 内核），其余读 / 写共用一份。 */
export type TaskRecoveryMutationOperations = Pick<
  TaskRecoveryOperations,
  | 'interruptBootOrphanTask'
  | 'interruptNodeRun'
  | 'repairRuntimeSessionLeaseAfterOrphanReap'
  | 'interruptPeriodicTaskIfIdle'
>

// RFC-359 AC-10：这里曾有一份 `repairRuntimeSessionLeaseAfterOrphanReapTx`——把租约修复的
// release / discard 两支**手抄**进一笔事务里，只给 PostgreSQL 的装配面用。抄的时候漏了
// `fenceTaskWrite` 那道任务归属闸，于是同一件事在两个引擎上强弱不同。两边现已统一走共享的
// lease 原语（`runtimeSessionLeaseOperations.repairAfterOrphanReap`），手抄件随之删除。

export function createTaskRecoveryOperations(
  db: PersistenceDb,
  mutations: TaskRecoveryMutationOperations,
  humanGates?: TaskRecoveryHumanGateFactsPort,
): TaskRecoveryOperations {
  const requireHumanGates = (): TaskRecoveryHumanGateFactsPort => {
    if (humanGates === undefined) throw new Error('task recovery human-gate facts are not composed')
    return humanGates
  }
  const operations: TaskRecoveryOperations = {
    async recordEvent(input: RecordTaskRecoveryEventInput): Promise<void> {
      const { recoveryEvents } = tablesOf(db)
      await insertOne(db, recoveryEvents, input)
    },

    async listEventsForTask(
      taskId: string,
      limit: number,
    ): Promise<readonly TaskRecoveryEventRecord[]> {
      const { recoveryEvents } = tablesOf(db)
      return queryRows(
        db
          .select()
          .from(recoveryEvents)
          .where(eq(recoveryEvents.taskId, taskId))
          .orderBy(desc(recoveryEvents.createdAt))
          .limit(limit),
      )
    },

    async isAutoRecoverySuspended(taskId: string): Promise<boolean> {
      const { tasks } = tablesOf(db)
      const row = await first(
        db
          .select({ suspended: tasks.autoRecoverySuspended })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1),
      )
      return row?.suspended ?? false
    },

    async recordAutoRecoveryAttempt(input) {
      return databaseSessionFor(db).transaction(async (tx) => {
        const { tasks } = tablesOf(tx)
        // 读—改—写：滑动窗口的计数由这次读自增，而 UPDATE 的 where 只有 id。auto-repair 与
        // heartbeat-kill 是两条各自定时的 loop，可以同时盯上同一个任务；不先锁住任务行，PG 的
        // READ COMMITTED 下两次尝试只会记成一次——用户配的 `maxAutoRecoveriesPerWindow` 闸门
        // 因此永不跳闸，任务被无限自动重跑（tests/rfc359-w8-t28-lost-update.test.ts L5）。
        await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, input.taskId)
        const row = await first(
          tx
            .select({
              attempts: tasks.autoRecoveryAttempts,
              windowStart: tasks.autoRecoveryWindowStartedAt,
              suspended: tasks.autoRecoverySuspended,
            })
            .from(tasks)
            .where(eq(tasks.id, input.taskId)),
        )
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
        return { suspended, attempts }
      })
    },

    async clearAutoRecoverySuspension(taskId: string): Promise<void> {
      const { tasks } = tablesOf(db)
      await db
        .update(tasks)
        .set({
          autoRecoverySuspended: false,
          autoRecoveryAttempts: 0,
          autoRecoveryWindowStartedAt: null,
        })
        .where(eq(tasks.id, taskId))
    },

    async listOpenLifecycleAlerts(taskId?: string): Promise<readonly TaskLifecycleAlertRecord[]> {
      const { lifecycleAlerts } = tablesOf(db)
      const predicate =
        taskId === undefined
          ? isNull(lifecycleAlerts.resolvedAt)
          : and(eq(lifecycleAlerts.taskId, taskId), isNull(lifecycleAlerts.resolvedAt))
      return queryRows(
        db
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
          .orderBy(asc(lifecycleAlerts.detectedAt)),
      )
    },

    async taskIdsWithRepoPrepRow(taskIds: readonly string[]): Promise<ReadonlySet<string>> {
      if (taskIds.length === 0) return new Set()
      const { nodeRuns } = tablesOf(db)

      const rows = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(and(inArray(nodeRuns.taskId, [...taskIds]), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
        .groupBy(nodeRuns.taskId)
        .limit(taskIds.length)
      return new Set(rows.map((row) => row.taskId))
    },

    async listStalledRunningChildren(input) {
      const { nodeRunEvents } = tablesOf(db)
      const { nodeRuns } = tablesOf(db)
      const nodeRunColumns = nodeRunReadColumns(db)
      const runs = await db
        .select({
          id: nodeRuns.id,
          seq: nodeRuns.seq,
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          pid: nodeRunColumns.pid,
          startedAt: nodeRuns.startedAt,
          spawnBinaryPath: nodeRunColumns.spawnBinaryPath,
          spawnLaunchNonce: nodeRunColumns.spawnLaunchNonce,
          parentNodeRunId: nodeRuns.historicalParentId,
          containerRunId: nodeRuns.containerRunId,
          childTaskId: nodeRuns.childTaskId,
        })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.status, 'running'), isNotNull(nodeRunColumns.pid)))
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
      const { nodeRuns } = tablesOf(db)

      const { tasks } = tablesOf(db)
      const projection = {
        id: tasks.id,
        workgroupId: taskReadColumns(db).workgroupId,
        workgroupConfig: taskWorkgroupConfigSelection(db),
        worktreePath: taskReadColumns(db).worktreePath,
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
      const { taskExecutionIntents, runtimeSessionLeases } = tablesOf(db)
      const { nodeRuns } = tablesOf(db)
      const nodeRunColumns = nodeRunReadColumns(db)
      const { tasks } = tablesOf(db)
      const taskCandidates = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(inArray(tasks.status, ['running', 'pending']))
      const runProjectionFields = {
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        pid: nodeRunColumns.pid,
        startedAt: nodeRuns.startedAt,
        spawnBinaryPath: nodeRunColumns.spawnBinaryPath,
        spawnLaunchNonce: nodeRunColumns.spawnLaunchNonce,
        parentNodeRunId: nodeRuns.historicalParentId,
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
      return mutations.interruptBootOrphanTask(input)
    },

    async interruptNodeRun(input): Promise<boolean> {
      return mutations.interruptNodeRun(input)
    },

    async listPeriodicReconcileCandidates(startedBefore: number) {
      const { nodeRuns } = tablesOf(db)
      const nodeRunColumns = nodeRunReadColumns(db)
      const rows = await db
        .select({
          id: nodeRuns.id,
          seq: nodeRuns.seq,
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          pid: nodeRunColumns.pid,
          startedAt: nodeRuns.startedAt,
          spawnBinaryPath: nodeRunColumns.spawnBinaryPath,
          spawnLaunchNonce: nodeRunColumns.spawnLaunchNonce,
          parentNodeRunId: nodeRuns.historicalParentId,
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
      const { nodeRuns } = tablesOf(db)
      const nodeRunColumns = nodeRunReadColumns(db)
      const { tasks } = tablesOf(db)
      const task = await first(
        db
          .select({ workflowSnapshot: taskReadColumns(db).workflowSnapshot })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1),
      )
      if (task === undefined) return null
      const rows = await db
        .select({
          id: nodeRuns.id,
          seq: nodeRuns.seq,
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          pid: nodeRunColumns.pid,
          startedAt: nodeRuns.startedAt,
          spawnBinaryPath: nodeRunColumns.spawnBinaryPath,
          spawnLaunchNonce: nodeRunColumns.spawnLaunchNonce,
          parentNodeRunId: nodeRuns.historicalParentId,
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
      const { runtimeSessionLeases } = tablesOf(db)
      const lease = await first(
        db
          .select({ sessionId: runtimeSessionLeases.sessionId })
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId))
          .limit(1),
      )
      return lease?.sessionId ?? null
    },

    async repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId: string): Promise<number> {
      return mutations.repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId)
    },

    async interruptPeriodicTaskIfIdle(input): Promise<boolean> {
      const { nodeRuns } = tablesOf(db)

      const active = await first(
        db
          .select({ id: nodeRuns.id })
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.taskId, input.taskId),
              inArray(nodeRuns.status, ['running', 'pending']),
            ),
          )
          .limit(1),
      )
      if (active !== undefined) return false
      return mutations.interruptPeriodicTaskIfIdle(input)
    },

    loadStuckTaskSnapshots: (taskIdFilter) =>
      loadStuckTaskSnapshots(db, requireHumanGates(), taskIdFilter),
    loadLifecycleInvariantSnapshots: (scope) =>
      loadLifecycleInvariantSnapshots(db, requireHumanGates(), scope),

    async reconcileStuckAlerts(input): Promise<TaskLifecycleAlertReconciliation> {
      const openRows = []
      if (input.taskIds.length > 0 && input.ownedRules.length > 0) {
        for (let offset = 0; offset < input.taskIds.length; offset += 500) {
          const taskIds = input.taskIds.slice(offset, offset + 500)
          const { lifecycleAlerts } = tablesOf(db)
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
        const { lifecycleAlerts } = tablesOf(db)
        await db
          .update(lifecycleAlerts)
          .set({ resolvedAt: input.now })
          .where(eq(lifecycleAlerts.id, row.id))
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
          const { lifecycleAlerts } = tablesOf(db)
          await insertOne(db, lifecycleAlerts, {
            id: row.id,
            taskId: row.taskId,
            rule: row.rule,
            severity: row.severity,
            detail: JSON.stringify(row.detail),
            detectedAt: row.detectedAt,
            resolvedAt: null,
          })
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
        const { lifecycleAlerts } = tablesOf(db)
        await db
          .update(lifecycleAlerts)
          .set({ severity, detail: JSON.stringify(finding.detail) })
          .where(eq(lifecycleAlerts.id, existing.id))
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

/** Admission covers the rows execution will use; recorded provenance is not an execution dependency. */
export async function assertTaskHistoryExecutableInTx(
  tx: PersistenceTx,
  restrictions: HistoryRestrictionPort,
  action: 'resume' | 'retry',
  taskId: string,
  requestedRunIds: readonly string[] = [],
): Promise<void> {
  if (!restrictions) throw new Error('task-history-restriction-provider-required')
  const { nodeRuns, nodeRunSelections } = tablesOf(tx)
  const selected = await tx
    .select({ id: nodeRunSelections.selectedRunId })
    .from(nodeRunSelections)
    .where(eq(nodeRunSelections.taskId, taskId))
  const { runtimeSessionLeases } = tablesOf(tx)
  const held = await tx
    .select({ id: runtimeSessionLeases.leaseNodeRunId })
    .from(runtimeSessionLeases)
    .where(eq(runtimeSessionLeases.taskId, taskId))
  const ids = new Set([
    ...requestedRunIds,
    ...selected.flatMap((row) => (row.id === null ? [] : [row.id])),
    ...held.flatMap((row) => (row.id === null ? [] : [row.id])),
  ])
  const history = await createRunSelectionReader(tx).familyHistory(taskId, {})
  const newestTopLevel = new Map<string, (typeof history)[number]>()
  const pendingSlots = new Map<string, (typeof history)[number]>()
  for (const row of history) {
    if (row.parentNodeRunId === null) newestTopLevel.set(row.nodeId, row)
    if (row.status !== 'pending') continue
    if (row.slot?.kind === 'workgroup-host') ids.add(row.id)
    if (row.slot?.kind === 'node' && !row.structurallySuperseded)
      pendingSlots.set(JSON.stringify(row.slot), row)
  }
  for (const row of newestTopLevel.values())
    if ((row.status === 'failed' || row.status === 'interrupted') && row.childTaskId === null)
      ids.add(row.id)
  for (const row of pendingSlots.values()) ids.add(row.id)
  const decision = await restrictions.check(tx, {
    action,
    taskId,
    nodeRunIds: [...ids].sort(),
    gates: [],
  })
  if (!decision.allowed)
    throw new ConflictError(
      'history-only',
      `task ${taskId} has history-only ${action} dependencies`,
      { restrictions: decision.restrictions },
    )
  for (let offset = 0; offset < ids.size; offset += 400) {
    const batch = [...ids].slice(offset, offset + 400)
    const rows = await tx
      .select({ id: nodeRuns.id, recordMode: nodeRuns.recordMode })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.id, batch)))
    if (rows.length !== batch.length || rows.some((row) => row.recordMode !== 'executable'))
      throw new ConflictError(
        'history-only',
        `task ${taskId} has unresolved ${action} dependencies`,
      )
  }
}
