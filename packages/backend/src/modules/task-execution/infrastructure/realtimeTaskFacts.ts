import { and, asc, eq, gt } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { RealtimeTaskFacts } from '../application/ports/realtimeTaskFacts'
import { readRealtimeTaskAudience } from './taskAuthorization'

export function createRealtimeTaskFacts(db: PersistenceDb): RealtimeTaskFacts {
  return {
    taskAudience: (taskId, userId) => readRealtimeTaskAudience(db, taskId, userId),
    async taskEventsSince(taskId, since) {
      const { nodeRunEvents } = tablesOf(db)
      const { nodeRuns } = tablesOf(db)
      return await db
        .select({
          id: nodeRunEvents.id,
          nodeRunId: nodeRunEvents.nodeRunId,
          ts: nodeRunEvents.ts,
          kind: nodeRunEvents.kind,
          payload: nodeRunEvents.payload,
        })
        .from(nodeRunEvents)
        .innerJoin(nodeRuns, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
        .where(and(eq(nodeRuns.taskId, taskId), gt(nodeRunEvents.id, since)))
        .orderBy(asc(nodeRunEvents.id))
    },
  }
}
