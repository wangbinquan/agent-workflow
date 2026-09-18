import { inArray } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents } from '@/db/schema'
import { canViewResource } from '@/modules/resource-catalog/composition/resourceAcl'
import { getWorkgroupById } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import { ensureWorkgroupHostWorkflow } from '@/modules/resource-catalog/infrastructure/legacy/workgroup/launch'
import type { AgentLaunchResourceIntegrityParticipant } from '@/modules/resource-catalog/public/participants'
import type { WorkgroupRouteLaunchResources } from './taskRouteLaunchOperations'

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①）—— 工作组启动的资源面，**两个 provider 唯一的一份**。
 *
 * 与 agent 那份（`agentLaunchResourceOperations.ts`，§5ge）同一个故事、同一个处方：
 * 差别不是引擎，而是**装配责任放在了不同的地方**——SQLite 那半在 `startWorkgroupTask`
 * 体内 `getWorkgroupById` + `canViewResource` 直接读库，PG 那半在守护进程根里注入一份
 * 走资源目录的实现。这里把读库那半收成唯一实现，两个根都用它。
 *
 * **为什么必须是这一半留下**（不是风格选择，是一处实撞的功能缺陷）：
 * PG 根注入的那份是 `workgroupCatalog.queries.get(directOperationAuthority(…, actor), …)`，
 * 而 `directOperationAuthority` 只认**凭据边缘铸出来的**那一个 actor 投影
 * （`operationContext.ts` 的 `directAuthorityForProjection`，认不出就抛
 * `foreign-legacy-actor-projection`）。定时 / webhook / 子任务这些非直连入口拿到的是
 * **委派** actor（`delegatedRequests.forSchedule` 等），投影表里根本没有它——
 * 于是 PostgreSQL 上**定时启动工作组任务当场 500**，SQLite 上一切正常。
 * 这正是 AC-1 要消灭的「两种数据库一个好一个不好」。
 *
 * ACL 判据两边**本来就是同一套**：`canViewResource(db, actor, …)` 与资源目录的
 * `authorization.canViewResource(authority, …)` 是同一个 application 方法的两个入口
 * （`composition/resourceAcl.ts:116`），区别只在传进去的投影对象要不要求「铸造出身」。
 * 所以收成读库那半**不改变任何可见性判定**，只是不再拒绝非直连 actor。
 */
export function createWorkgroupLaunchResourceOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}): WorkgroupRouteLaunchResources {
  const { db } = input
  return Object.freeze({
    async loadVisible(actor: Actor, workgroupId: string) {
      const group = await getWorkgroupById(db, workgroupId)
      if (group === null || !(await canViewResource(db, actor, 'workgroup', group))) return null
      return group
    },
    /**
     * 名册成员的存在性检查**不带 actor**：问的是「这个 agent 还在不在」，
     * 不是「请求者看不看得见它」——后者已由 `loadVisible` 的 ACL-404 挡在前面
     *（`startWorkgroupTask` 原文同形：一条 `select agents.id where in (…)`）。
     */
    async loadExistingAgentIds(agentIds: readonly string[]): Promise<readonly string[]> {
      const unique = [...new Set(agentIds)]
      if (unique.length === 0) return []
      const rows = await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, unique))
      return rows.map((row) => row.id)
    },
    ensureHostWorkflow: () => ensureWorkgroupHostWorkflow(db),
    integrity: input.integrity,
  })
}
