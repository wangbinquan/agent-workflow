import { and, eq, ne } from 'drizzle-orm'

import { taskNodeClarifyDirectives } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  ClarifyDirectiveRow,
  ClarifyDirectiveStore,
} from '../application/ports/clarifyDirectiveStore'

export function createPostgresqlClarifyDirectiveStore(
  db: PostgresqlDatabaseClient,
): ClarifyDirectiveStore {
  const store: ClarifyDirectiveStore = {
    async get(input): Promise<ClarifyDirectiveRow | null> {
      const rows = await db
        .select({
          shardKey: taskNodeClarifyDirectives.shardKey,
          directive: taskNodeClarifyDirectives.directive,
          updatedAt: taskNodeClarifyDirectives.updatedAt,
        })
        .from(taskNodeClarifyDirectives)
        .where(
          and(
            eq(taskNodeClarifyDirectives.taskId, input.taskId),
            eq(taskNodeClarifyDirectives.nodeId, input.nodeId),
          ),
        )
      const key = input.shardKey ?? ''
      const row =
        rows.find((candidate) => candidate.shardKey === key) ??
        rows.find((candidate) => candidate.shardKey === '')
      return row === undefined ? null : { directive: row.directive, updatedAt: row.updatedAt }
    },
    async listNodeDirectives(taskId) {
      const rows = await db
        .select({
          nodeId: taskNodeClarifyDirectives.nodeId,
          shardKey: taskNodeClarifyDirectives.shardKey,
          directive: taskNodeClarifyDirectives.directive,
        })
        .from(taskNodeClarifyDirectives)
        .where(eq(taskNodeClarifyDirectives.taskId, taskId))
      return rows
        .filter((row) => row.shardKey === '')
        .map((row) => ({ nodeId: row.nodeId, directive: row.directive }))
    },
    async set(input) {
      const key = input.shardKey ?? ''
      const now = input.now ?? Date.now()
      await db.transaction(async (tx) => {
        await tx
          .insert(taskNodeClarifyDirectives)
          .values({
            taskId: input.taskId,
            nodeId: input.nodeId,
            shardKey: key,
            directive: input.directive,
            setBy: input.setBy,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              taskNodeClarifyDirectives.taskId,
              taskNodeClarifyDirectives.nodeId,
              taskNodeClarifyDirectives.shardKey,
            ],
            set: { directive: input.directive, setBy: input.setBy, updatedAt: now },
          })
          .run()
        if (key === '' && input.directive === 'continue') {
          await tx
            .delete(taskNodeClarifyDirectives)
            .where(
              and(
                eq(taskNodeClarifyDirectives.taskId, input.taskId),
                eq(taskNodeClarifyDirectives.nodeId, input.nodeId),
                ne(taskNodeClarifyDirectives.shardKey, ''),
              ),
            )
            .run()
        }
      })
    },
  }
  return Object.freeze(store)
}
