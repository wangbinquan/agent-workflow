import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createAgentImportQueries } from '../application/agents/agentImportQueries'
import { createAgentImportReferenceReadPort } from '../infrastructure/agentImportQueries'
import type { AgentImportQueries } from '../public/queries'

/** 一份装配，两个 provider 共用（RFC-359 W4-D14）。 */
export function composeAgentImportQueries(db: PersistenceDb): AgentImportQueries {
  return createAgentImportQueries(createAgentImportReferenceReadPort(db))
}
