import { and, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds } from '@/db/schema'
import { autoDispatchDeferredQuestions } from '@/services/clarify/autoDispatch'
import { loadUndispatchedParkTargets } from '@/services/taskQuestions'
import type {
  TaskDagCollaborationOperations,
  TaskDagOpenClarifyEvidence,
} from '../application/ports/taskDagCollaborationOperations'

export function createSqliteTaskDagCollaborationOperations(
  db: DbClient,
): TaskDagCollaborationOperations {
  return Object.freeze({
    autoDispatchDeferredQuestions: (taskId: string) => autoDispatchDeferredQuestions(db, taskId),
    async loadOpenClarifyEvidence(taskId: string): Promise<TaskDagOpenClarifyEvidence> {
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
    },
    loadUndispatchedParkTargets: (taskId: string) => loadUndispatchedParkTargets(db, taskId),
  })
}
