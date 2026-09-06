import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

import type {
  AgentCatalogModule,
  SkillCatalogModule,
  WorkflowCatalogModule,
} from '../public/operations'
import {
  createAgentPersistenceSemantics,
  type AgentRuntimeProfileLookup,
} from '../infrastructure/agentPersistenceSemantics'
import {
  createSkillContentAvailability,
  type SkillContentAvailability,
} from '../infrastructure/skillContentAvailability'
import type { SkillRestoreMembershipPort } from '../infrastructure/legacy/skillVersion'
import { composeAgentImportQueries } from './agentImportQueries'
import {
  composeAgentResourceIntegrity,
  composeDatabaseAgentResourceInventorySource,
  type AgentResourceIntegrityComposition,
} from './agentResourceIntegrity'
import { composeAgentCatalog } from './agentOperations'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { composeSkillCatalog } from './skillOperations'
import { composeDatabaseWorkflowCatalog } from './workflowOperations'

export interface PostgresqlClassicCatalogBundle {
  readonly agent: AgentCatalogModule
  readonly skill: SkillCatalogModule
  readonly workflow: WorkflowCatalogModule
  readonly agentResourceIntegrity: AgentResourceIntegrityComposition
  /**
   * RFC-359 W4-D23c：技能内容可用性。此前这里是 PostgreSQL 私有的 873 行内容生命周期
   * （ZIP 导入 / 工作流校验 / 启动装配共用），随原生技能实现一并退役；剩下真正被外部需要的
   * 只是「这个技能的内容在不在」，由两个数据库共用的文件系统实现回答（与 SQLite 侧同一份）。
   */
  readonly skillContent: SkillContentAvailability
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
  readonly restoreMembership: SkillRestoreMembershipPort
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}): PostgresqlClassicCatalogBundle {
  const skillContent = createSkillContentAvailability({ appHome: input.appHome })
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
  const skill = composeSkillCatalog({
    db: input.db,
    appHome: input.appHome,
    restoreMembership: input.restoreMembership,
  })
  const workflow = composeDatabaseWorkflowCatalog({
    db: input.db,
    resourceCatalog: input.resourceCatalog,
    skillContent,
  })
  return Object.freeze({ agent, skill, workflow, agentResourceIntegrity, skillContent })
}
