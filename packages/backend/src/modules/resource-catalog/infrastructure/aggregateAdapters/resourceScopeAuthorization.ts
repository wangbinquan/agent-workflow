// RFC-359 W4-D4 —— memory 资源 scope 访问判定要的两件事实（scope 资源行、授权档）：一份实现，两个 provider 共用。
// 两个读都落在调用方交来的统一事务句柄上；没有 provider 客户端、事务句柄或行经 resource-catalog 的 public 合同外泄。

import { isTaskDefinitionHostId } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { ResourceScopeAccessReads } from '../../application/participants/resourceAuthorization'
import type { ResourceMemoryScopeRef } from '../../public/types'

// 导出的是**事实读取器**，不是 capability——名字也不叫 `create*`；铸 participant 的唯一工厂在 application。
export const resourceScopeAccessReads: ResourceScopeAccessReads<PersistenceTx> = {
  async scopeRow(transaction, scope: ResourceMemoryScopeRef) {
    if (scope.kind === 'agent') {
      const { agents } = tablesOf(transaction)
      const rows = await transaction
        .select({ ownerUserId: agents.ownerUserId, visibility: agents.visibility })
        .from(agents)
        .where(eq(agents.id, scope.id))
        .limit(1)
      return rows[0] ?? null
    }
    if (isTaskDefinitionHostId(scope.id)) return { ownerUserId: null, visibility: 'public' }
    const { workflows } = tablesOf(transaction)
    const rows = await transaction
      .select({ ownerUserId: workflows.ownerUserId, visibility: workflows.visibility })
      .from(workflows)
      .where(eq(workflows.id, scope.id))
      .limit(1)
    return rows[0] ?? null
  },
  async grantLevel(transaction, scope: ResourceMemoryScopeRef, userId: string) {
    const { resourceGrants } = tablesOf(transaction)
    const rows = await transaction
      .select({ level: resourceGrants.level })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, scope.kind),
          eq(resourceGrants.resourceId, scope.id),
          eq(resourceGrants.userId, userId),
        ),
      )
      .limit(1)
    return rows[0]?.level ?? null
  },
}
