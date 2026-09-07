// RFC-359 W8 —— 目录自有 ACL 类型的**同步（`DbTxSync`）读法**。异步那一半在这里已经没有实现了。
//
// 此前这份文件里另有七个 async 读（`findOwnedAclResourceIdsByName` / `loadAclResourceNamesByIds` /
// `getAclResourceOwner` / `listOwnedAclResourceNames` / `getAclResourceAccessRow` /
// `listAclResourceIdentityRowsByIds` / `listAclResourceIdentityRowsByNames`），与
// `aclReadRepository.ts` 里同名的那七个**逐字相同**（只差参数写成 `DbClient` 而不是
// `ProviderNeutralDatabase`——而 `DbClient` 本来就是它的一个实例）。同一件事两份实现，一边改了
// 另一边漏改就是行为漂移，正是 RFC-359 要消灭的形态。现在它们直接 re-export 中立那一份：
// **导出面逐字不变**（调用方与 `services/resourceAcl.ts` 的再导出都不用动），实现只剩一份。
// `tests/rfc359-w4-b2b-adapters.test.ts` 用**函数同一性**断言钉住这件事——谁再 fork 一份回来，
// `===` 立刻红。
//
// 留在这里的五个 `*InTx` 是真差异：它们吃 `DbTxSync`，跑在 bun:sqlite 单连接的同步显式事务里
// （`db/txSync.ts`），PostgreSQL 上没有这个形态。`dbTxSync` 归零时它们随之退役。

import type { AclResourceType } from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import type { DbTxSync } from '@/db/txSync'
import type { AclRow } from '../domain/resourceAccess'
import { ownedAclTable } from './aclReadRepository'

export {
  findOwnedAclResourceIdsByName,
  getAclResourceAccessRow,
  getAclResourceOwner,
  listAclResourceIdentityRowsByIds,
  listAclResourceIdentityRowsByNames,
  listOwnedAclResourceNames,
  loadAclResourceNamesByIds,
  type AclResourceIdentitySnapshot,
} from './aclReadRepository'

import type { AclResourceIdentitySnapshot } from './aclReadRepository'

export function getAclResourceOwnerInTx(
  tx: DbTxSync,
  type: AclResourceType,
  id: string,
): string | null | undefined {
  const table = ownedAclTable(type)
  return tx.select({ ownerUserId: table.ownerUserId }).from(table).where(eq(table.id, id)).get()
    ?.ownerUserId
}

export function getAclResourceAccessRowInTx(
  tx: DbTxSync,
  type: AclResourceType,
  id: string,
): AclRow | null {
  const table = ownedAclTable(type)
  return (
    tx
      .select({
        id: table.id,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(eq(table.id, id))
      .get() ?? null
  )
}

export function getAclResourceIdentityRowInTx(
  tx: DbTxSync,
  type: AclResourceType,
  id: string,
): AclResourceIdentitySnapshot | null {
  const table = ownedAclTable(type)
  return (
    (tx
      .select({
        id: table.id,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
        aclRevision: table.aclRevision,
      })
      .from(table)
      .where(eq(table.id, id))
      .get() as AclResourceIdentitySnapshot | undefined) ?? null
  )
}

export function listAclResourceIdentityRowsByIdsInTx(
  tx: DbTxSync,
  type: AclResourceType,
  ids: readonly string[],
): AclResourceIdentitySnapshot[] {
  if (ids.length === 0) return []
  const table = ownedAclTable(type)
  return tx
    .select({
      id: table.id,
      name: table.name,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
      aclRevision: table.aclRevision,
    })
    .from(table)
    .where(inArray(table.id, [...ids]))
    .all() as AclResourceIdentitySnapshot[]
}

export function listAclResourceIdentityRowsByNamesInTx(
  tx: DbTxSync,
  type: AclResourceType,
  names: readonly string[],
): AclResourceIdentitySnapshot[] {
  if (names.length === 0) return []
  const table = ownedAclTable(type)
  return tx
    .select({
      id: table.id,
      name: table.name,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
      aclRevision: table.aclRevision,
    })
    .from(table)
    .where(inArray(table.name, [...names]))
    .all() as AclResourceIdentitySnapshot[]
}
