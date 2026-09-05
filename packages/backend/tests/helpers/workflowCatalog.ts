// RFC-359 —— 双引擎测试用的工作流目录装配：一份中立装配，两个 provider 共用；用例体本身看不见 provider。

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeDatabaseWorkflowCatalog } from '@/modules/resource-catalog/composition/workflowOperations'
import type { WorkflowCatalogModule } from '@/modules/resource-catalog/public/operations'
import type { WorkflowOperationContext } from '@/modules/resource-catalog/public/participants'

export function workflowCatalogFor(db: ProviderNeutralDatabase): WorkflowCatalogModule {
  return composeDatabaseWorkflowCatalog({
    db,
    resourceCatalog: composeResourceCatalogFor({ db }),
    skillContent: { isAvailable: async () => true },
  })
}

export function workflowAuthorityFor(
  userId: string,
  role: 'admin' | 'user' = 'admin',
): WorkflowOperationContext {
  const actor = buildActor({
    user: { id: userId, username: `u-${userId}`, displayName: userId, role, status: 'active' },
    source: 'session',
  })
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
}
