import type { Agent } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  canViewResource,
  composeProviderResourceAclOperationApplication,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { assertNotBuiltin, excludeBuiltinAgents } from '@/services/systemResources'
import { createAgentApplication } from '../application/agents/agentApplication'
import type { AgentAccessPort, AgentPolicyPort, AgentRepository } from '../application/agents/ports'
import { createSqliteAgentRepository } from '../infrastructure/sqliteAgentRepository'
import {
  createPostgresqlAgentRepository,
  type PostgresqlAgentPersistenceSemantics,
} from '../infrastructure/postgresqlAgentRepository'
import { createAgentOperationDescriptors } from './catalogOperationDescriptors'
import type { AgentCatalogModule } from '../public/operations'
import type { AgentOperationContext } from '../public/participants'
import type { AgentImportQueries, AgentResourceIntegrityQueries } from '../public/queries'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export interface AgentCatalogCompositionDependencies {
  readonly db: DbClient
  readonly importQueries: AgentImportQueries
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
}

type AgentAclOperationApplication = Parameters<typeof createAgentOperationDescriptors>[2]

export interface AgentCatalogAdapterCompositionDependencies {
  readonly repository: AgentRepository
  readonly access: AgentAccessPort
  readonly policy: AgentPolicyPort
  readonly acl: AgentAclOperationApplication
  readonly importQueries: AgentImportQueries
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
}

export interface PostgresqlAgentCatalogCompositionDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly persistence: PostgresqlAgentPersistenceSemantics
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
  readonly importQueries: AgentImportQueries
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
}

export function composeAgentCatalogFromAdapters(
  input: AgentCatalogAdapterCompositionDependencies,
): AgentCatalogModule {
  const application = createAgentApplication({
    repository: input.repository,
    access: input.access,
    policy: input.policy,
  })
  const operations = createAgentOperationDescriptors(
    application.commands,
    application.queries,
    input.acl,
  )
  return Object.freeze({
    queries: application.queries,
    referenceQueries: application.referenceQueries,
    dependencyQueries: application.dependencyQueries,
    importQueries: input.importQueries,
    resourceIntegrityQueries: input.resourceIntegrityQueries,
    operations,
  })
}

export function composePostgresqlAgentCatalog(
  input: PostgresqlAgentCatalogCompositionDependencies,
): AgentCatalogModule {
  const repository = createPostgresqlAgentRepository({
    db: input.db,
    semantics: input.persistence,
  })
  const access = Object.freeze({
    filterVisible: (authority: AgentOperationContext, rows: readonly Agent[]) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'agent', rows),
    canView: (authority: AgentOperationContext, row: Agent) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'agent', row),
    requireResourceEdit: async (authority: AgentOperationContext, row: Agent) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'agent', row)
    },
    requireResourceGovern: (authority: AgentOperationContext, row: Agent) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'agent', row),
  } satisfies AgentAccessPort)
  const policy = Object.freeze({
    excludeBuiltin: (rows: readonly Agent[]) => excludeBuiltinAgents([...rows]),
    assertMutable: (row: Agent) => assertNotBuiltin('agent', row),
  } satisfies AgentPolicyPort)
  const acl = composeProviderResourceAclOperationApplication<AgentOperationContext, 'agent', Agent>(
    {
      ...input.resourceCatalog,
      type: 'agent',
      load: (id) => repository.get(id),
    },
  )
  return composeAgentCatalogFromAdapters({
    repository,
    access,
    policy,
    acl,
    importQueries: input.importQueries,
    resourceIntegrityQueries: input.resourceIntegrityQueries,
  })
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
  const acl = composeResourceAclOperationApplication<AgentOperationContext, Agent>({
    db: input.db,
    type: 'agent',
    load: (id) => repository.get(id),
  })
  return composeAgentCatalogFromAdapters({
    repository,
    access,
    policy,
    acl,
    importQueries: input.importQueries,
    resourceIntegrityQueries: input.resourceIntegrityQueries,
  })
}
