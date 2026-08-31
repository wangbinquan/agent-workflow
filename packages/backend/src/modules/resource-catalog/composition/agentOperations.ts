import type { Agent } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import { assertNotBuiltin, excludeBuiltinAgents } from '@/services/systemResources'
import { createAgentApplication } from '../application/agents/agentApplication'
import type { AgentAccessPort, AgentPolicyPort } from '../application/agents/ports'
import { createSqliteAgentRepository } from '../infrastructure/sqliteAgentRepository'
import { createAgentOperationDescriptors, type AgentCatalogModule } from '../public/operations'
import type { AgentOperationContext } from '../public/participants'

export interface AgentCatalogCompositionDependencies {
  readonly db: DbClient
}

export function composeAgentCatalog(
  input: AgentCatalogCompositionDependencies,
): AgentCatalogModule {
  const repository = createSqliteAgentRepository(input.db)
  const access: AgentAccessPort = Object.freeze({
    filterVisible: (authority: AgentOperationContext, rows: readonly Agent[]) =>
      filterVisibleRows(input.db, authority, 'agent', [...rows]),
    canView: (authority: AgentOperationContext, row: Agent) =>
      canViewResource(input.db, authority, 'agent', row),
    requireResourceEdit: async (authority: AgentOperationContext, row: Agent) => {
      await requireResourceEdit(input.db, authority, 'agent', row)
    },
    requireResourceGovern: (authority: AgentOperationContext, row: Agent) =>
      requireResourceGovern(input.db, authority, 'agent', row),
  })
  const policy: AgentPolicyPort = Object.freeze({
    excludeBuiltin: (rows: readonly Agent[]) => excludeBuiltinAgents([...rows]),
    assertMutable: (row: Agent) => assertNotBuiltin('agent', row),
  })
  const application = createAgentApplication({ repository, access, policy })
  const acl = composeResourceAclOperationApplication<AgentOperationContext, Agent>({
    db: input.db,
    type: 'agent',
    load: (id) => repository.get(id),
  })
  const operations = createAgentOperationDescriptors(application.commands, application.queries, acl)
  return Object.freeze({
    queries: application.queries,
    referenceQueries: application.referenceQueries,
    operations,
  })
}
