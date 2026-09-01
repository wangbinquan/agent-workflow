import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'

import type {
  AgentCatalogModule,
  SkillCatalogModule,
  WorkflowCatalogModule,
} from '../public/operations'
import type {
  PostgresqlSkillContentLifecycle,
  PostgresqlSkillMemoryFusionParticipantFactory,
} from '../infrastructure/postgresqlSkillRepository'
import {
  createPostgresqlAgentPersistenceSemantics,
  type AgentRuntimeProfileLookup,
} from '../infrastructure/postgresqlAgentPersistenceSemantics'
import { createPostgresqlSkillContentLifecycle } from '../infrastructure/postgresqlSkillContentLifecycle'
import { createPostgresqlWorkflowPersistenceSemantics } from '../infrastructure/postgresqlWorkflowPersistenceSemantics'
import { composePostgresqlAgentImportQueries } from './agentImportQueries'
import {
  composeAgentResourceIntegrity,
  composePostgresqlAgentResourceInventorySource,
  type AgentResourceIntegrityComposition,
} from './agentResourceIntegrity'
import { composePostgresqlAgentCatalog } from './agentOperations'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { composePostgresqlSkillCatalog } from './skillOperations'
import { composePostgresqlWorkflowCatalog } from './workflowOperations'

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
  readonly memoryFusion: PostgresqlSkillMemoryFusionParticipantFactory
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}): PostgresqlClassicCatalogBundle {
  const skillContent = createPostgresqlSkillContentLifecycle({
    db: input.db,
    appHome: input.appHome,
    memoryFusion: input.memoryFusion,
  })
  const agentResourceInventory = composePostgresqlAgentResourceInventorySource({
    db: input.db,
    authorization: input.resourceCatalog.authorization,
  })
  const agentResourceIntegrity = composeAgentResourceIntegrity(agentResourceInventory)
  const agent = composePostgresqlAgentCatalog({
    db: input.db,
    persistence: createPostgresqlAgentPersistenceSemantics({
      db: input.db,
      authorization: input.resourceCatalog.authorization,
      resourceInventory: agentResourceInventory,
      runtimeProfiles: input.runtimeProfiles,
    }),
    resourceCatalog: input.resourceCatalog,
    importQueries: composePostgresqlAgentImportQueries(input.db),
    resourceIntegrityQueries: agentResourceIntegrity.queries,
  })
  const skill = composePostgresqlSkillCatalog({
    db: input.db,
    content: skillContent,
    resourceCatalog: input.resourceCatalog,
  })
  const workflow = composePostgresqlWorkflowCatalog({
    db: input.db,
    persistence: createPostgresqlWorkflowPersistenceSemantics({
      authorization: input.resourceCatalog.authorization,
      events: {
        created(created) {
          workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
            type: 'workflow.created',
            workflowId: created.id,
            name: created.name,
            version: created.version,
          })
        },
        updated(receipt) {
          workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
            type: 'workflow.updated',
            workflowId: receipt.revision.workflowId,
            clientMutationId: receipt.clientMutationId,
            version: receipt.revision.version,
            snapshotHash: receipt.revision.snapshotHash,
            updatedAt: receipt.revision.updatedAt,
          })
        },
        deleted(workflowId, deletedVersion, deletion) {
          workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
            type: 'workflow.deleted',
            workflowId,
            clientMutationId: deletion.clientMutationId,
            deletedVersion,
          })
        },
      },
    }),
    skillContent,
    resourceCatalog: input.resourceCatalog,
  })
  return Object.freeze({ agent, skill, workflow, agentResourceIntegrity, skillContent })
}
