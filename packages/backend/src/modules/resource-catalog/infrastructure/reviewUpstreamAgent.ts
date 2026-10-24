import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { ReviewUpstreamAgentQuery } from '../application/ports/reviewUpstreamAgent'

export function createReviewUpstreamAgentQuery(db: PersistenceDb): ReviewUpstreamAgentQuery {
  return {
    async outputProfile(agentId) {
      const { agents } = tablesOf(db)
      const rows = await db
        .select({
          syncOutputsOnIterate: agents.syncOutputsOnIterate,
          outputs: agents.outputs,
          frontmatterExtra: agents.frontmatterExtra,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
