import type { Mcp } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createMcpApplication } from '../application/mcps/mcpApplication'
import type {
  McpAccessPort,
  McpOperationCoordinatorPort,
  McpProjection,
  McpRepository,
  McpRuntimeLifecyclePort,
} from '../application/mcps/ports'
import { createMcpAclIdentityParticipant } from '../application/participants/mcpAclIdentity'
import { createMcpRepository, type McpTransactionLifecycle } from '../infrastructure/mcpRepository'
import { transitionMcpAclRuntimeTests } from '../infrastructure/mcpRuntimeTestTransitions'
import type { ResourceAclMutationLifecycle } from '../infrastructure/resourceAclRepository'
import { composeProviderResourceAclOperationApplication } from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { createMcpOperationDescriptors } from './catalogOperationDescriptors'
import type { McpCatalogModule } from '../public/operations'

type McpAclOperationApplication = Parameters<typeof createMcpOperationDescriptors>[2]

export interface McpCatalogAdapterCompositionDependencies {
  readonly repository: McpRepository
  readonly projection: McpProjection
  readonly access: McpAccessPort
  readonly acl: McpAclOperationApplication
  readonly coordinator: McpOperationCoordinatorPort
  readonly nextMutationTimestamp: (mcp: Mcp) => Promise<number>
  readonly runtime: McpRuntimeLifecyclePort
  readonly id?: () => string
  readonly now?: () => number
}

export interface McpCatalogCompositionDependencies extends Omit<
  McpCatalogAdapterCompositionDependencies,
  'repository' | 'projection' | 'access' | 'acl'
> {
  readonly db: ProviderNeutralDatabase
  readonly lifecycle: McpTransactionLifecycle
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}

export function composeMcpCatalogFromAdapters(
  input: McpCatalogAdapterCompositionDependencies,
): McpCatalogModule {
  const clock = Object.freeze({ next: input.nextMutationTimestamp })
  const application = createMcpApplication({
    repository: input.repository,
    projection: input.projection,
    access: input.access,
    coordinator: input.coordinator,
    clock,
    runtime: input.runtime,
    id: input.id ?? ulid,
    now: input.now ?? Date.now,
  })
  const aclIdentity = createMcpAclIdentityParticipant({
    repository: input.repository,
    clock,
  })
  const operations = createMcpOperationDescriptors(
    application.commands,
    application.queries,
    input.acl,
  )
  return Object.freeze({
    queries: application.queries,
    operations,
    participants: Object.freeze({ aclIdentity }),
  })
}

/**
 * 目录 ACL 写事务里的 MCP 运行时测试失效：装进 `composeResourceCatalogFor({ lifecycle })`，两个 provider 同一份
 * （此前只有 SQLite 的 ACL 装配接了这条 afterWriteInTx，PG 上改 ACL 不会结束 / 阻塞已失去可见性的测试会话）。
 */
export function mcpAclRuntimeTestLifecycle(): ResourceAclMutationLifecycle {
  const lifecycle: ResourceAclMutationLifecycle = {
    async afterWriteInTransaction(transaction, change) {
      if (change.type !== 'mcp') return
      await transitionMcpAclRuntimeTests(transaction, {
        mcpId: change.resourceId,
        ownerUserId: change.ownerUserId,
        visibility: change.visibility,
        grantedUserIds: change.grantedUserIds,
        now: change.now,
      })
    },
  }
  return Object.freeze(lifecycle)
}

/** 一份装配，两个 provider 共用（RFC-359 W4-D16）：仓库 / 生命周期 / ACL 应用都已是中立实现。 */
export function composeMcpCatalog(input: McpCatalogCompositionDependencies): McpCatalogModule {
  const { repository, projection } = createMcpRepository({
    db: input.db,
    lifecycle: input.lifecycle,
  })
  const access = Object.freeze({
    filterVisible: (authority, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'mcp', rows),
    canView: (authority, row) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'mcp', row),
    requireResourceEdit: async (authority, row) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'mcp', row)
    },
    requireResourceGovern: (authority, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'mcp', row),
    discloseAgentReferences: (authority, references) =>
      input.resourceCatalog.authorization.discloseRefs(authority, 'agent', references),
  } satisfies McpAccessPort)
  const acl = composeProviderResourceAclOperationApplication({
    ...input.resourceCatalog,
    type: 'mcp',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => input.coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: (row) => input.nextMutationTimestamp(row),
    },
    afterUpdated: () => input.runtime.reconcileDurableIntents(),
  })
  return composeMcpCatalogFromAdapters({ ...input, repository, projection, access, acl })
}
