import { and, eq, inArray, ne } from 'drizzle-orm'

import { nodeRunEvents, nodeRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import type { RuntimeSessionCapturePersistence } from '../application/ports/runtimeSessionCapturePersistence'
import {
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

export function createPostgresqlRuntimeSessionCapturePersistence(
  db: PostgresqlDatabaseClient,
): RuntimeSessionCapturePersistence {
  return Object.freeze({
    async resolveTaskId(
      nodeRunId: Parameters<RuntimeSessionCapturePersistence['resolveTaskId']>[0],
    ) {
      const rows = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0]?.taskId ?? null
    },
    async listSiblingCapturedSessionIds(
      input: Parameters<RuntimeSessionCapturePersistence['listSiblingCapturedSessionIds']>[0],
    ) {
      const siblings = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, input.taskId), ne(nodeRuns.id, input.nodeRunId)))
      if (siblings.length === 0) return new Set<string>()
      const rows = await db
        .selectDistinct({ sessionId: nodeRunEvents.sessionId })
        .from(nodeRunEvents)
        .where(
          inArray(
            nodeRunEvents.nodeRunId,
            siblings.map((row) => row.id),
          ),
        )
      return new Set(
        rows.flatMap((row) =>
          row.sessionId === null || row.sessionId.length === 0 ? [] : [row.sessionId],
        ),
      )
    },
    async appendEvents(input: Parameters<RuntimeSessionCapturePersistence['appendEvents']>[0]) {
      if (input.events.length === 0) return
      const context = currentTaskExecutionContext(input.taskId)
      await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        if (context === undefined) await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
        else await assertPostgresqlTaskOwnerTx(tx, context.token, Date.now())
        await tx
          .insert(nodeRunEvents)
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
      })
    },
  })
}
