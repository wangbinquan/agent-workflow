import { and, eq, inArray, ne } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import { retrySqliteWrite } from '@/db/sqliteWriteRetry'
import type { RuntimeSessionCapturePersistence } from '../application/ports/runtimeSessionCapturePersistence'
import { withTaskExecutionTransaction } from './sqliteOwnedTaskMutation'

export function createSqliteRuntimeSessionCapturePersistence(
  db: DbClient,
): RuntimeSessionCapturePersistence {
  return Object.freeze({
    async resolveTaskId(
      nodeRunId: Parameters<RuntimeSessionCapturePersistence['resolveTaskId']>[0],
    ) {
      return (
        db
          .select({ taskId: nodeRuns.taskId })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .get()?.taskId ?? null
      )
    },
    async listSiblingCapturedSessionIds(
      input: Parameters<RuntimeSessionCapturePersistence['listSiblingCapturedSessionIds']>[0],
    ) {
      const siblings = db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, input.taskId), ne(nodeRuns.id, input.nodeRunId)))
        .all()
      if (siblings.length === 0) return new Set<string>()
      const rows = db
        .selectDistinct({ sessionId: nodeRunEvents.sessionId })
        .from(nodeRunEvents)
        .where(
          inArray(
            nodeRunEvents.nodeRunId,
            siblings.map((row) => row.id),
          ),
        )
        .all()
      return new Set(
        rows.flatMap((row) =>
          row.sessionId === null || row.sessionId.length === 0 ? [] : [row.sessionId],
        ),
      )
    },
    async appendEvents(input: Parameters<RuntimeSessionCapturePersistence['appendEvents']>[0]) {
      if (input.events.length === 0) return
      await retrySqliteWrite(() =>
        withTaskExecutionTransaction({
          db,
          taskId: input.taskId,
          run: (tx) => {
            tx.insert(nodeRunEvents)
              .values(
                input.events.map((event: (typeof input.events)[number]) => ({
                  nodeRunId: input.nodeRunId,
                  ts: event.ts,
                  kind: event.kind,
                  payload: event.payload,
                  sessionId: event.sessionId,
                  parentSessionId: event.parentSessionId,
                })),
              )
              .run()
          },
        }),
      )
    },
  })
}
