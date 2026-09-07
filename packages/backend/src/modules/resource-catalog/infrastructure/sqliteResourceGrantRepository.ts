// RFC-359 W10 —— 授权集读法里**仍住在这里**的那些。这份文件头逐条对得上导出面，别读成
// 「异步已经清空了」：清掉的只有下面点名的三个。
//
// **收回中立那一份的三个（现在是 re-export，不是实现）**：`listGrantedResourceIds` /
// `loadGrantLevel` / `loadGrantLevelsForUser`。它们与 `resourceVisibility.ts` 的
// `createResourceGrantReadPort` 里同名的三个**曾经逐字相同**（只差参数写成 `DbClient`——
// 而 `DbClient` 本来就是 `ProviderNeutralDatabase` 的一个实例）。同一件事两份实现、且
// **两份在同一个 SQLite 进程里同时活着**：中立那份喂 `createResourceAuthorizationApplication`
// （列表页可见性过滤与 access 徽章），这一份被 `legacy/agent.ts` / `legacy/resourceRefs.ts` /
// `task-execution/infrastructure/legacyCallClosure.ts` 直接调用。一边改了另一边漏改，用户看到的
// 就是同一个资源在列表页和引用检查里权限不一致。现在实现只剩一份，**导出面逐字不变**
// （调用方与 `services/resourceAcl.ts` 的再导出都不用动）；
// `tests/rfc359-w10-grant-read-conformance.test.ts` 用**函数同一性**断言钉住，谁 fork 回来立刻红。
//
// **四个 `*InTx` 留着，是真差异**：`listGrantedResourceIdsInTx` / `listResourceGrantsInTx` /
// `listResourceGrantUserIdsInTx` / `loadGrantLevelInTx` 吃 `DbTxSync`，跑在 bun:sqlite 单连接的
// 同步显式事务里（`db/txSync.ts`），PostgreSQL 上没有这个形态。`dbTxSync` 归零时随之退役。
//
// **三个 async 留着，但不是同一个理由**（W10 逐个 import 核过，别当成「还没轮到」）：
//   - `listWritableGrantedResourceIds` —— 没有孪生，是 `listGrantedResourceIds` 加一层 `level='write'`
//     过滤；调用方只有 `legacy/skill-zip.ts`。它早就吃 `ProviderNeutralDatabase`，**名字里的
//     `sqlite` 已经是假的**，属于命名债不是分叉债，随改名那一刀归位。
//   - `listResourceGrantUserIds` / `listResourceGrants` —— `packages/backend/src` 下**零调用方**
//     （`listResourceGrants` 连 `services/resourceAcl.ts` 的再导出都没人取用；
//     `listResourceGrantUserIds` 连再导出都没有）。是死代码，但退役会同时改动
//     `tests/architecture/rfc349-provider-cutover.test.ts` 的 facade 导出账本——那份此刻正被
//     并发的刀改着，**为避免撞车留到下一刀**，理由记在这里而不是留一句「TODO」。

import type { GrantResourceType, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { DbTxSync } from '@/db/txSync'
import { resourceGrants } from '@/db/schema'
import type { ResourceAclActorProjection } from '../domain/resourceAccess'
import { grantsOfResourceWhere, grantsOfUserWhere } from './resourceVisibility'

export {
  listGrantedResourceIds,
  loadGrantLevel,
  loadGrantLevelsForUser,
} from './resourceVisibility'

export function listGrantedResourceIdsInTx(
  tx: DbTxSync,
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Set<string> {
  const rows = tx
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(grantsOfUserWhere(type, actor.user.id))
    .all()
  return new Set(rows.map((row) => row.resourceId))
}

export async function listResourceGrantUserIds(
  db: DbClient,
  type: GrantResourceType,
  resourceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
  return rows.map((row) => row.userId)
}

export async function listResourceGrants(
  db: DbClient,
  type: GrantResourceType,
  resourceId: string,
): Promise<Array<{ userId: string; level: ResourceGrantLevel }>> {
  return db
    .select({ userId: resourceGrants.userId, level: resourceGrants.level })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
}

export function listResourceGrantsInTx(
  tx: DbTxSync,
  type: GrantResourceType,
  resourceId: string,
): Map<string, ResourceGrantLevel> {
  return new Map(
    tx
      .select({ userId: resourceGrants.userId, level: resourceGrants.level })
      .from(resourceGrants)
      .where(grantsOfResourceWhere(type, resourceId))
      .all()
      .map((row) => [row.userId, row.level] as const),
  )
}

export function listResourceGrantUserIdsInTx(
  tx: DbTxSync,
  type: GrantResourceType,
  resourceId: string,
): string[] {
  return tx
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
    .all()
    .map((row) => row.userId)
}

export async function listWritableGrantedResourceIds(
  db: ProviderNeutralDatabase,
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(grantsOfUserWhere(type, actor.user.id), eq(resourceGrants.level, 'write')))
  return new Set(rows.map((row) => row.resourceId))
}

export function loadGrantLevelInTx(
  tx: DbTxSync,
  type: GrantResourceType,
  resourceId: string,
  userId: string,
): ResourceGrantLevel | null {
  return (
    tx
      .select({ level: resourceGrants.level })
      .from(resourceGrants)
      .where(and(grantsOfResourceWhere(type, resourceId), eq(resourceGrants.userId, userId)))
      .get()?.level ?? null
  )
}

// RFC-359 W4-B2：可见性阶梯、grant 谓词与 Promise 形态的 grant 读端口只有一份（resourceVisibility.ts）；
// 这里保留给 legacy 同步调用方的 `*InTx` 读法（dbTxSync 归零时删）。
export {
  grantsOfResourceWhere,
  grantsOfUserWhere,
  visibleRowsCondition,
  type AclColumnRef,
} from './resourceVisibility'
