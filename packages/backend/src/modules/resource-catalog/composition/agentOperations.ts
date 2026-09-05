import type { Agent } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { composeProviderResourceAclOperationApplication } from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { assertNotBuiltin, excludeBuiltinAgents } from '@/services/systemResources'
import { createAgentApplication } from '../application/agents/agentApplication'
import type {
  AgentAccessPort,
  AgentPolicyPort,
  AgentRepository,
  AgentResourceInventorySource,
} from '../application/agents/ports'
import {
  createAgentRepository,
  type AgentPersistenceSemantics,
} from '../infrastructure/agentRepository'
import {
  createAgentPersistenceSemantics,
  type AgentRuntimeProfileLookup,
} from '../infrastructure/agentPersistenceSemantics'
import { createAgentOperationDescriptors } from './catalogOperationDescriptors'
import type { AgentCatalogModule } from '../public/operations'
import type { AgentOperationContext } from '../public/participants'
import type { AgentImportQueries, AgentResourceIntegrityQueries } from '../public/queries'

type AgentAclOperationApplication = Parameters<typeof createAgentOperationDescriptors>[2]

export interface AgentCatalogAdapterCompositionDependencies {
  readonly repository: AgentRepository
  readonly access: AgentAccessPort
  readonly policy: AgentPolicyPort
  readonly acl: AgentAclOperationApplication
  readonly importQueries: AgentImportQueries
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
}

export interface AgentCatalogCompositionDependencies {
  readonly db: ProviderNeutralDatabase
  readonly persistence: AgentPersistenceSemantics
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

/** 一份装配，两个 provider 共用（RFC-359 W4-D14）：仓库 / 语义 / ACL 应用都已是中立实现。 */
export function composeAgentCatalog(
  input: AgentCatalogCompositionDependencies,
): AgentCatalogModule {
  const repository = createAgentRepository({
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

/**
 * Bootstrap 装配：从数据库句柄直接装出 Agent 目录——语义层在这里装，bootstrap 不碰 infrastructure
 * （RFC-294 §3.1 的 offered 边只允许 bootstrap → composition）。
 */
export function composeDatabaseAgentCatalog(input: {
  readonly db: ProviderNeutralDatabase
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
  readonly resourceInventory: AgentResourceInventorySource
  readonly runtimeProfiles: AgentRuntimeProfileLookup
  readonly importQueries: AgentImportQueries
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
}): AgentCatalogModule {
  return composeAgentCatalog({
    db: input.db,
    persistence: createAgentPersistenceSemantics({
      db: input.db,
      authorization: input.resourceCatalog.authorization,
      resourceInventory: input.resourceInventory,
      runtimeProfiles: input.runtimeProfiles,
    }),
    resourceCatalog: input.resourceCatalog,
    importQueries: input.importQueries,
    resourceIntegrityQueries: input.resourceIntegrityQueries,
  })
}
