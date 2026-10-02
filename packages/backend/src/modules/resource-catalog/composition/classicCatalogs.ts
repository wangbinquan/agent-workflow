import type { ProviderNeutralDatabase } from '@/db/query'

import type {
  AgentCatalogModule,
  SkillCatalogModule,
  WorkflowCatalogModule,
} from '../public/operations'
import {
  createAgentPersistenceSemantics,
  type AgentRuntimeProfileLookup,
} from '../infrastructure/agentPersistenceSemantics'
import type {
  SkillContentAvailability,
  SkillVersionPresenceQueries,
} from '../application/skills/contentAvailability'
import type { SkillRestoreMembershipPort } from '../infrastructure/legacy/skillVersion'
import { composeAgentImportQueries } from './agentImportQueries'
import {
  composeAgentResourceIntegrity,
  composeDatabaseAgentResourceInventorySource,
  type AgentResourceIntegrityComposition,
} from './agentResourceIntegrity'
import { composeAgentCatalog } from './agentOperations'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { composeSkillCatalog, type SkillCatalogCompositionDependencies } from './skillOperations'
import {
  composeDatabaseWorkflowCatalog,
  composeSkillContentAvailability,
} from './workflowOperations'

export interface ClassicCatalogBundle {
  readonly agent: AgentCatalogModule
  readonly skill: SkillCatalogModule
  readonly workflow: WorkflowCatalogModule
  readonly agentResourceIntegrity: AgentResourceIntegrityComposition
  /**
   * RFC-359 W4-D23c：技能内容可用性。此前这里是 PostgreSQL 私有的 873 行内容生命周期
   * （ZIP 导入 / 工作流校验 / 启动装配共用），随原生技能实现一并退役；剩下真正被外部需要的
   * 只是「这个技能的内容在不在」，由 AW 的共同启动判据与所选存储事实回答。
   */
  readonly skillContent: SkillContentAvailability
}

/**
 * The shared agent, skill and workflow composition for both daemon providers.
 *
 * `appHome` is the managed Resource Catalog artifact root. Callers never bind
 * filesystem/journal mechanics or persistence semantics themselves.
 */
export interface ClassicCatalogCompositionDependencies extends Omit<
  SkillCatalogCompositionDependencies,
  'db' | 'appHome' | 'restoreMembership'
> {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly restoreMembership: SkillRestoreMembershipPort
  readonly runtimeProfiles: AgentRuntimeProfileLookup
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
  readonly versionPresence?: SkillVersionPresenceQueries
}

export function composeClassicCatalogs(
  input: ClassicCatalogCompositionDependencies,
): ClassicCatalogBundle {
  const skillContent = composeSkillContentAvailability({
    appHome: input.appHome,
    versionPresence: input.versionPresence,
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
  const skill = composeSkillCatalog({
    db: input.db,
    appHome: input.appHome,
    restoreMembership: input.restoreMembership,
    content: input.content,
    versionReader: input.versionReader,
    lifecycleContent: input.lifecycleContent,
    deletionContent: input.deletionContent,
    versionContent: input.versionContent,
    creationContent: input.creationContent,
  })
  const workflow = composeDatabaseWorkflowCatalog({
    db: input.db,
    resourceCatalog: input.resourceCatalog,
    skillContent,
  })
  return Object.freeze({ agent, skill, workflow, agentResourceIntegrity, skillContent })
}
