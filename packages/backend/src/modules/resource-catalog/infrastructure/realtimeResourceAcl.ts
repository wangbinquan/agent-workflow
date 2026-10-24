import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { RealtimeResourceAcl } from '../application/ports/realtimeResourceAcl'
import { createWorkflowExecutionQueries } from './executionResourceQueries'

export function createRealtimeResourceAcl(db: PersistenceDb): RealtimeResourceAcl {
  const workflows = createWorkflowExecutionQueries(db)
  return {
    async find(kind, id) {
      if (kind === 'workflow') {
        const row = (await workflows.summaries([id]))[0]
        return row === undefined
          ? null
          : { id: row.id, ownerUserId: row.ownerUserId, visibility: row.visibility }
      }
      const { workgroups } = tablesOf(db)
      const rows = await db
        .select({
          id: workgroups.id,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(eq(workgroups.id, id))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
