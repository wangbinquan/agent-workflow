import { asc, eq } from 'drizzle-orm'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { AgentDependencyReadPort } from '../application/ports/agentDependencyRead'

export function createAgentDependencyReadPort(
  db: PersistenceDb | PersistenceTx,
  _source: 'semantics' | 'package' | 'other' = 'other',
): AgentDependencyReadPort {
  return {
    async load(id) {
      const { agents, agentDependencies } = tablesOf(db)
      const row = (
        await db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).limit(1)
      )[0]
      if (row === undefined) return undefined
      return (
        await db
          .select({ id: agentDependencies.dependencyAgentId })
          .from(agentDependencies)
          .where(eq(agentDependencies.agentId, id))
          .orderBy(asc(agentDependencies.ordinal))
      ).map((ref) => ref.id)
    },
  }
}
