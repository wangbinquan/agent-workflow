// RFC-359 W4-B3 —— 人工门 continuation 的恢复查询：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq } from 'drizzle-orm'

import { isLegacyTaskGateContinuationPayload } from '@/modules/task-execution/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HumanGateContinuationRecoveryQueries } from '../application/ports/humanGateContinuationRecovery'

export function createHumanGateContinuationRecoveryQueries(
  db: PersistenceDb,
): HumanGateContinuationRecoveryQueries {
  return {
    async listPending() {
      const { taskExecutionIntents } = tablesOf(db)
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

      return rows
        .filter((row) => !isLegacyTaskGateContinuationPayload(row.payloadJson))
        .map(({ taskId, continuationRef }) => ({ taskId, continuationRef }))
    },
  }
}
