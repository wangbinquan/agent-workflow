import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm'

import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  DeferredTaskQuestionDispatcher,
  TaskDagCollaborationOperations,
  TaskDagOpenClarifyEvidence,
} from '../application/ports/taskDagCollaborationOperations'
import { partitionTaskDagParkTargets, type TaskDagParkEntry } from './taskDagCollaborationReads'

async function loadOpenClarifyEvidence(
  db: PostgresqlDatabaseClient,
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
  db: PostgresqlDatabaseClient,
  taskId: string,
): Promise<readonly TaskDagParkEntry[]> {
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
  db: PostgresqlDatabaseClient,
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

export function createPostgresqlTaskDagCollaborationOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly deferredQuestions: DeferredTaskQuestionDispatcher
}): TaskDagCollaborationOperations {
  return Object.freeze({
    autoDispatchDeferredQuestions: (taskId: string) =>
      input.deferredQuestions.autoDispatchDeferredQuestions(taskId),
    loadOpenClarifyEvidence: (taskId: string) => loadOpenClarifyEvidence(input.db, taskId),
    loadUndispatchedParkTargets: (taskId: string) => loadUndispatchedParkTargets(input.db, taskId),
  })
}
