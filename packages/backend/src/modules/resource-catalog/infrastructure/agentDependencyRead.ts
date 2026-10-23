import { eq } from 'drizzle-orm'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { AgentDependencyReadPort } from '../application/ports/agentDependencyRead'
import { decodeAgentReferenceIds } from './agentReferenceCodec'

export function createAgentDependencyReadPort(
  db: PersistenceDb | PersistenceTx,
  source: 'semantics' | 'package' | 'other' = 'other',
): AgentDependencyReadPort {
  return {
    async load(id) {
      const { agents } = tablesOf(db)
      const row = (
        await db
          .select(
            source === 'package'
              ? { id: agents.id, dependsOn: agents.dependsOn }
              : { dependsOn: agents.dependsOn },
          )
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1)
      )[0]
      return row === undefined
        ? undefined
        : decodeAgentReferenceIds(source === 'semantics' ? () => row.dependsOn : row.dependsOn)
    },
  }
}
