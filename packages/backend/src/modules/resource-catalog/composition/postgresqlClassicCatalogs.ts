import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

import type {
  AgentCatalogModule,
  SkillCatalogModule,
  WorkflowCatalogModule,
} from '../public/operations'
import type { PostgresqlSkillContentLifecycle } from '../infrastructure/postgresqlSkillRepository'
import {
  createAgentPersistenceSemantics,
  type AgentRuntimeProfileLookup,
} from '../infrastructure/agentPersistenceSemantics'
import {
  createPostgresqlSkillContentLifecycle,
  type PostgresqlSkillRestoreMembershipPort,
} from '../infrastructure/postgresqlSkillContentLifecycle'
import { composeAgentImportQueries } from './agentImportQueries'
import {
  composeAgentResourceIntegrity,
  composeDatabaseAgentResourceInventorySource,
  type AgentResourceIntegrityComposition,
} from './agentResourceIntegrity'
import { composeAgentCatalog } from './agentOperations'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { composePostgresqlSkillCatalog } from './skillOperations'
import { composeDatabaseWorkflowCatalog } from './workflowOperations'

export interface PostgresqlClassicCatalogBundle {
  readonly agent: AgentCatalogModule
  readonly skill: SkillCatalogModule
  readonly workflow: WorkflowCatalogModule
  readonly agentResourceIntegrity: AgentResourceIntegrityComposition
  /** Provider-private lifecycle reused by ZIP import, workflow validation and boot composition. */
  readonly skillContent: PostgresqlSkillContentLifecycle
}

/**
 * The single PostgreSQL classic-six composition entrypoint.
 *
 * `appHome` is the managed Resource Catalog artifact root. Callers never bind
 * filesystem/journal mechanics or persistence semantics themselves.
 */
export function composePostgresqlClassicCatalogs(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly runtimeProfiles: AgentRuntimeProfileLookup
  readonly restoreMembership: PostgresqlSkillRestoreMembershipPort
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}): PostgresqlClassicCatalogBundle {
  const skillContent = createPostgresqlSkillContentLifecycle({
    db: input.db,
    appHome: input.appHome,
    restoreMembership: input.restoreMembership,
  })
  const agentResourceInventory = composeDatabaseAgentResourceInventorySource({
    db: input.db,
    authorization: input.resourceCatalog.authorization,
  })
  const agentResourceIntegrity = composeAgentResourceIntegrity(agentResourceInventory)
  const agent = composeAgentCatalog({
    db: input.db,
    persistence: createAgentPersistenceSemantics({
      db: input.db,
      authorization: input.resourceCatalog.authorization,
      resourceInventory: agentResourceInventory,
      runtimeProfiles: input.runtimeProfiles,
    }),
    resourceCatalog: input.resourceCatalog,
    importQueries: composeAgentImportQueries(input.db),
    resourceIntegrityQueries: agentResourceIntegrity.queries,
  })
  const skill = composePostgresqlSkillCatalog({
    db: input.db,
    content: skillContent,
    resourceCatalog: input.resourceCatalog,
  })
  const workflow = composeDatabaseWorkflowCatalog({
    db: input.db,
    resourceCatalog: input.resourceCatalog,
    skillContent,
  })
  return Object.freeze({ agent, skill, workflow, agentResourceIntegrity, skillContent })
}
