import { and, asc, eq } from 'drizzle-orm'

import { taskExecutionIntents } from '@/db/schema'
import { isLegacyTaskGateContinuationPayload } from '@/modules/task-execution/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { HumanGateContinuationRecoveryQueries } from '../application/ports/humanGateContinuationRecovery'

export function createPostgresqlHumanGateContinuationRecoveryQueries(
  db: PostgresqlDatabaseClient,
): HumanGateContinuationRecoveryQueries {
  return {
    async listPending() {
      const rows = await db
        .select({
          taskId: taskExecutionIntents.taskId,
          continuationRef: taskExecutionIntents.id,
          payloadJson: taskExecutionIntents.payloadJson,
        })
        .from(taskExecutionIntents)
        .where(
          and(
            eq(taskExecutionIntents.kind, 'gate-continuation'),
            eq(taskExecutionIntents.state, 'pending'),
          ),
        )
        .orderBy(asc(taskExecutionIntents.createdAt), asc(taskExecutionIntents.id))
        .all()
      return rows
        .filter((row) => !isLegacyTaskGateContinuationPayload(row.payloadJson))
        .map(({ taskId, continuationRef }) => ({ taskId, continuationRef }))
    },
  }
}
