// RFC-359 W1-T1（P0-7）—— task-DAG 调度器消费的 collaboration 投影：一份实现，两个引擎。
//
// 此前 `sqliteTaskDagCollaborationOperations.ts` 与 `postgresqlTaskDagCollaborationOperations.ts`
// 各一份；PostgreSQL 那份的 `autoDispatchDeferredQuestions` 委托给一个从未被 bind 的 holder，
// 生产上每次 tick 抛 `deferred-question-dispatcher-not-bound`（dual-provider-parity-audit P0-7）。
// 派发管线（`legacySqliteTaskQuestionDispatch.ts`）已跑在 `DatabaseSession` 上，这里直接调用它。

import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions } from '@/db/schema'
import type {
  TaskDagCollaborationOperations,
  TaskDagOpenClarifyEvidence,
} from '../application/ports/taskDagCollaborationOperations'
import { partitionTaskDagParkTargets, type TaskDagParkEntry } from './taskDagCollaborationReads'

async function loadOpenClarifyEvidence(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<TaskDagOpenClarifyEvidence> {
  const rows = await db
    .select({
      nodeId: clarifyRounds.intermediaryNodeId,
      askingRunId: clarifyRounds.askingNodeRunId,
    })
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, taskId),
        eq(clarifyRounds.status, 'awaiting_human'),
        inArray(clarifyRounds.kind, ['self', 'cross']),
      ),
    )
  return Object.freeze({
    clarifyNodeIds: new Set(rows.map((row) => row.nodeId)),
    askingRunIds: new Set(
      rows.flatMap((row) =>
        row.askingRunId === null || row.askingRunId.length === 0 ? [] : [row.askingRunId],
      ),
    ),
  })
}

async function loadParkEntries(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<readonly TaskDagParkEntry[]> {
  const projection = {
    dispatchedAt: taskQuestions.dispatchedAt,
    triggerRunId: taskQuestions.triggerRunId,
    defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
    overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
  }
  // RFC-120 T9 (Codex H2): a directive='stop' round skips the designer rerun — never park on it.
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
  // RFC-120 §15 (Codex impl-gate H1): a MANUAL designer row has a synthetic origin with NO clarify
  // round, so the INNER JOIN above misses it — yet an undispatched manual row with a handler MUST
  // park its node exactly like a clarify designer row.
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
  const selfQuestioner = await db
    .select(projection)
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        ne(taskQuestions.confirmation, 'confirmed'),
        isNotNull(taskQuestions.sealedAt),
      ),
    )
  return Object.freeze([...clarifyDesigner, ...manualDesigner, ...selfQuestioner])
}

async function loadUndispatchedParkTargets(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<ReadonlySet<string>> {
  const entries = await loadParkEntries(db, taskId)
  if (entries.length === 0) return new Set()
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
  return partitionTaskDagParkTargets(entries, runs, new Set(outputRows.map((row) => row.nodeRunId)))
}

export function createTaskDagCollaborationOperations(
  db: ProviderNeutralDatabase,
): TaskDagCollaborationOperations {
  return Object.freeze({
    // 动态 import：本文件从 collaboration 的 composition barrel 导出，而派发管线经
    // services/humanGateComposition 绕回同一个 barrel——静态 import 会形成值环（TDZ）。
    autoDispatchDeferredQuestions: async (taskId: string) => {
      const { autoDispatchDeferredQuestions } = await import('./legacySqliteClarify/autoDispatch')
      await autoDispatchDeferredQuestions(db, taskId)
    },
    loadOpenClarifyEvidence: (taskId: string) => loadOpenClarifyEvidence(db, taskId),
    loadUndispatchedParkTargets: (taskId: string) => loadUndispatchedParkTargets(db, taskId),
  })
}
