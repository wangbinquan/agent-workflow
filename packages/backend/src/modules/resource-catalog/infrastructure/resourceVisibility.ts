// RFC-359 W4-B2 —— 目录资源的 ACL 表注册 + 可见性谓词 + grant 读端口：一份实现，两个 provider 共用。
//
// 此前 `sqliteAclRegistry` / `postgresqlAclRegistry` 各登记一份逐字相同的表注册，
// `sqliteResourceGrantRepository` / `postgresqlResourceGrantRepository` 各写一份逐字相同的可见性阶梯 SQL。
// 这里是唯一的一份；SQLite 侧仍保留给 legacy 同步调用方的 `*InTx` 读法（dbTxSync 归零时删）。
//
// **W4-B2 这句「唯一的一份」当时只对 `visibleRowsCondition` 成立**（RFC-359 W10 逐行对过）：
// `listGrantedResourceIds` / `loadGrantLevel` / `loadGrantLevelsForUser` 三个 async 读法在
// `sqliteResourceGrantRepository.ts` 里还留着逐字相同的第二份，且两份在同一个 SQLite 进程里
// 同时被调用。W10 把那三份收回这里、由 legacy 文件按名 re-export，这句话才真正成立。
// 教训写在这里而不是删掉：**文件头写「已经只有一份」不构成证据**，判据要么是函数同一性断言，
// 要么是一条能红的守卫。

import type { AclResourceType, GrantResourceType, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  actionTemplates,
  agents,
  automationPolicies,
  capabilityTemplates,
  digitalEmployees,
  mcps,
  plugins,
  resourceGrants,
  skills,
  verificationProfiles,
  workflows,
  workgroups,
} from '@/db/schema'
import type {
  ResourceCatalogGrantReadPort,
  ResourceCatalogOwnedAclType,
} from '../application/ports/providerResourceCatalogPersistence'
import {
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'

/** RFC-345 D4 —— canonical ACL roster 的表注册（两个 provider 共用同一张逻辑表清单）。 */
export const ACL_TABLES = {
  agent: agents,
  skill: skills,
  mcp: mcps,
  plugin: plugins,
  workflow: workflows,
  workgroup: workgroups,
  capability_template: capabilityTemplates,
  action_template: actionTemplates,
  verification_profile: verificationProfiles,
  digital_employee: digitalEmployees,
  automation_policy: automationPolicies,
} as const satisfies Readonly<Record<ResourceCatalogOwnedAclType, object>>

export type AclTableFor<K extends ResourceCatalogOwnedAclType> = (typeof ACL_TABLES)[K]

/** The canonical grant-set predicate, shared by async and in-transaction reads. */
export function grantsOfUserWhere(type: GrantResourceType, userId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, userId))
}

/** The canonical by-resource predicate, shared by audience and ACL reads. */
export function grantsOfResourceWhere(type: GrantResourceType, resourceId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId))
}

/** Column handles accepted by the count-only visibility projection. */
export interface AclColumnRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
  readonly visibility: SQLWrapper
}

/** SQL twin of the domain visibility ladder for count-only surfaces. */
export function visibleRowsCondition(
  db: ProviderNeutralDatabase,
  actor: ResourceAclActorProjection,
  type: AclResourceType,
  cols: AclColumnRef,
): SQL<unknown> | undefined {
  if (hasResourceAclBypass(actor)) return undefined
  const isPublic = sql`COALESCE(${cols.visibility}, 'public') = 'public'`
  if (!hasPrivateResourceAccess(actor)) return isPublic
  const granted = inArray(
    cols.id,
    db
      .select({ resourceId: resourceGrants.resourceId })
      .from(resourceGrants)
      .where(grantsOfUserWhere(type, actor.user.id)),
  )
  return or(isPublic, sql`${cols.ownerUserId} = ${actor.user.id}`, granted)!
}

/**
 * RFC-359 W10 —— 授权集读法的**唯一一份**实现。
 *
 * 本文件头（W4-B2 写的）当时就宣称「可见性阶梯 SQL 这里是唯一的一份」，但那句话只对
 * `visibleRowsCondition` 成立：下面这三个读法在 `sqliteResourceGrantRepository.ts` 里
 * **另有一份逐字相同的拷贝**（只差参数写成 `DbClient`——而 `DbClient` 本来就是
 * `ProviderNeutralDatabase` 的一个实例），并且两份**在同一个 SQLite 进程里同时活着**：
 * 中立那份喂 `createResourceAuthorizationApplication`（两个引擎共用），拷贝那份被
 * `infrastructure/legacy/agent.ts` / `legacy/resourceRefs.ts` / task-execution 的
 * `legacyCallClosure.ts` 直接调用。同一个问题（「这个用户被授权了哪些资源 / 什么档位」）
 * 由两条代码路径回答，改一边漏一边就是用户可见的漂移：列表页的 access 徽章、编辑按钮的
 * 可用性、以及授权者能不能收到实时刷新推送。
 *
 * 现在拷贝那一份按名 re-export 这里（`sqliteResourceGrantRepository.ts`），实现只剩一份；
 * `tests/rfc359-w10-grant-read-conformance.test.ts` 用**函数同一性**钉住，谁再 fork 回来
 * `toBe` 立刻红。
 */
export async function listGrantedResourceIds(
  db: ProviderNeutralDatabase,
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(grantsOfUserWhere(type, actor.user.id))
  return new Set(rows.map((row) => row.resourceId))
}

/**
 * 「引用检查要看的那批被授权 id」：**bypass 直接给空集**（它看得见全部，授权集无意义），
 * 否则就是 `listGrantedResourceIds`。
 *
 * RFC-359 W57：`workflowPersistenceSemantics.ts` 与 `agentPersistenceSemantics.ts` 此前各存
 * 一份**逐字相同**的私有 `grantedIds`——而它的查询与本文件的 `listGrantedResourceIds`
 * 一字不差，两份副本只是各自在前面加了同一句 bypass 短路。收在这里，两个语义文件都直接用。
 */
export async function grantedResourceIdsFor(
  db: Parameters<typeof listGrantedResourceIds>[0],
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Promise<ReadonlySet<string>> {
  if (hasResourceAclBypass(actor)) return new Set()
  return await listGrantedResourceIds(db, actor, type)
}

export async function loadGrantLevel(
  db: ProviderNeutralDatabase,
  type: GrantResourceType,
  resourceId: string,
  userId: string,
): Promise<ResourceGrantLevel | null> {
  const rows = await db
    .select({ level: resourceGrants.level })
    .from(resourceGrants)
    .where(and(grantsOfResourceWhere(type, resourceId), eq(resourceGrants.userId, userId)))
    .limit(1)
  return rows[0]?.level ?? null
}

/**
 * 分批 500 不是装饰：两个引擎的绑定参数数量都有上限（bun:sqlite 默认 32766，PostgreSQL 协议
 * 65535），一次把几千个 id 塞进 `IN (…)` 会在**行数够多时**才炸。分批口径两侧必须一致，
 * 否则「同一份列表页在两个引擎上徽章不一样」只会在大目录上出现。
 */
export async function loadGrantLevelsForUser(
  db: ProviderNeutralDatabase,
  type: GrantResourceType,
  resourceIds: readonly string[],
  userId: string,
): Promise<Map<string, ResourceGrantLevel>> {
  const out = new Map<string, ResourceGrantLevel>()
  for (let index = 0; index < resourceIds.length; index += 500) {
    const chunk = resourceIds.slice(index, index + 500)
    const rows = await db
      .select({ resourceId: resourceGrants.resourceId, level: resourceGrants.level })
      .from(resourceGrants)
      .where(and(grantsOfUserWhere(type, userId), inArray(resourceGrants.resourceId, chunk)))
    for (const row of rows) out.set(row.resourceId, row.level)
  }
  return out
}

/** Promise-shaped grant reads used by the composition root on both providers. */
export function createResourceGrantReadPort(
  db: ProviderNeutralDatabase,
): ResourceCatalogGrantReadPort {
  const port: ResourceCatalogGrantReadPort = {
    listGrantedResourceIds: (actor, type) => listGrantedResourceIds(db, actor, type),
    loadGrantLevel: (type, resourceId, userId) => loadGrantLevel(db, type, resourceId, userId),
    loadGrantLevelsForUser: (type, resourceIds, userId) =>
      loadGrantLevelsForUser(db, type, resourceIds, userId),
  }
  return Object.freeze(port)
}
