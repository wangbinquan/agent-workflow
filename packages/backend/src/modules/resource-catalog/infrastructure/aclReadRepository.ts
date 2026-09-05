// RFC-359 W4-D3 —— resource-catalog 自有 ACL 类型的读端口：一份实现，两个 provider 共用。
// 快照读在同一个目录写事务原语里（SERIALIZABLE：identity / grants / users 三张表一致），owner / name 预检直接读。

import type { AclResourceType, UserPublic } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { resourceGrants, users } from '@/db/schema'
import type {
  ResourceCatalogAclIdentityReadPort,
  ResourceCatalogAclReadPort,
  ResourceCatalogOwnedAclType,
} from '../application/ports/providerResourceCatalogPersistence'
import type { ResourceAclIdentityPersistence } from '../application/ports/resourceAclPersistence'
import type { AclRow } from '../domain/resourceAccess'
import { ACL_TABLES } from './aclRegistry'
import { runResourceCatalogTransaction } from './resourceCatalogTransaction'

export type OwnedAclResourceType = ResourceCatalogOwnedAclType

export function isOwnedAclResourceType(type: AclResourceType): type is OwnedAclResourceType {
  return type in ACL_TABLES
}

/** 非目录自有的类型（development_adapter / employee_*）由各自 owner 的 identity persistence 承担，这里不认。 */
export function ownedAclTable(type: AclResourceType) {
  if (!isOwnedAclResourceType(type)) {
    throw new Error(`ACL identity persistence is required for ${type}`)
  }
  return ACL_TABLES[type]
}

export interface AclResourceIdentitySnapshot extends AclRow {
  readonly name: string
  readonly aclRevision: number
}

export async function findOwnedAclResourceIdsByName(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  ownerUserId: string,
  name: string,
): Promise<string[]> {
  const table = ownedAclTable(type)
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.name, name), eq(table.ownerUserId, ownerUserId)))
  return rows.map((row) => row.id)
}

export async function loadAclResourceNamesByIds(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const table = ownedAclTable(type)
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(inArray(table.id, [...ids]))
  return new Map(rows.map((row) => [row.id, row.name]))
}

export async function getAclResourceOwner(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  id: string,
): Promise<string | null | undefined> {
  const table = ownedAclTable(type)
  const rows = await db
    .select({ ownerUserId: table.ownerUserId })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  return rows[0]?.ownerUserId
}

export async function listOwnedAclResourceNames(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  ownerUserId: string,
): Promise<string[]> {
  const table = ownedAclTable(type)
  const rows = await db
    .select({ name: table.name })
    .from(table)
    .where(eq(table.ownerUserId, ownerUserId))
  return rows.map((row) => row.name)
}

export async function getAclResourceAccessRow(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  id: string,
): Promise<AclRow | null> {
  const table = ownedAclTable(type)
  const rows = await db
    .select({ id: table.id, ownerUserId: table.ownerUserId, visibility: table.visibility })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  return rows[0] ?? null
}

export async function listAclResourceIdentityRowsByIds(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  ids: readonly string[],
): Promise<AclResourceIdentitySnapshot[]> {
  if (ids.length === 0) return []
  const table = ownedAclTable(type)
  return (await db
    .select({
      id: table.id,
      name: table.name,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
      aclRevision: table.aclRevision,
    })
    .from(table)
    .where(inArray(table.id, [...ids]))) as AclResourceIdentitySnapshot[]
}

export async function listAclResourceIdentityRowsByNames(
  db: ProviderNeutralDatabase,
  type: AclResourceType,
  names: readonly string[],
): Promise<AclResourceIdentitySnapshot[]> {
  if (names.length === 0) return []
  const table = ownedAclTable(type)
  return (await db
    .select({
      id: table.id,
      name: table.name,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
      aclRevision: table.aclRevision,
    })
    .from(table)
    .where(inArray(table.name, [...names]))) as AclResourceIdentitySnapshot[]
}

/**
 * RFC-359 W4-D6：非目录自有的类型由 owner 的 identity persistence 给 aclRevision，identity 行取调用方交来的
 * fallback（路由已经加载并授权过的那一行）；目录自有类型直接读 ACL_TABLES。grants / users 两条路径同一份。
 */
export function createResourceAclReadPort(
  db: ProviderNeutralDatabase,
  identityPersistence?: ResourceAclIdentityPersistence,
): ResourceCatalogAclReadPort<AclResourceType> {
  const port: ResourceCatalogAclReadPort<AclResourceType> = {
    async readSnapshot(type, resourceId, fallbackIdentity) {
      if (identityPersistence !== undefined && identityPersistence.type !== type) {
        throw new Error(
          `ACL identity persistence type ${identityPersistence.type} cannot serve ${type}`,
        )
      }
      const table = identityPersistence === undefined ? ownedAclTable(type) : null
      return runResourceCatalogTransaction(db, async (transaction) => {
        const identity =
          table === null
            ? {
                ...fallbackIdentity,
                aclRevision: await identityPersistence!.getRevision(resourceId),
              }
            : (
                await transaction
                  .select({
                    id: table.id,
                    ownerUserId: table.ownerUserId,
                    visibility: table.visibility,
                    aclRevision: table.aclRevision,
                  })
                  .from(table)
                  .where(eq(table.id, resourceId))
                  .limit(1)
              )[0]
        if (identity === undefined) return null
        const grants = await transaction
          .select({ userId: resourceGrants.userId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(
            and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId)),
          )
        const userIds = [
          ...new Set([
            ...(typeof identity.ownerUserId === 'string' ? [identity.ownerUserId] : []),
            ...grants.map((grant) => grant.userId),
          ]),
        ]
        const userRows =
          userIds.length === 0
            ? []
            : await transaction
                .select({
                  id: users.id,
                  username: users.username,
                  displayName: users.displayName,
                  role: users.role,
                  status: users.status,
                })
                .from(users)
                .where(inArray(users.id, userIds))
        return {
          identity: {
            id: identity.id,
            ownerUserId: identity.ownerUserId ?? null,
            visibility: identity.visibility ?? 'public',
          },
          aclRevision: identity.aclRevision,
          grants,
          users: new Map<string, UserPublic>(userRows.map((row) => [row.id, row])),
        }
      })
    },
  }
  return Object.freeze(port)
}

/** Internal owner/name preflight reads used by Intent apply preflight. */
export function createResourceCatalogAclIdentityReadPort(
  db: ProviderNeutralDatabase,
): ResourceCatalogAclIdentityReadPort {
  const port: ResourceCatalogAclIdentityReadPort = {
    getOwner: (type, id) => getAclResourceOwner(db, type, id),
    listOwnedNames: (type, ownerUserId) => listOwnedAclResourceNames(db, type, ownerUserId),
  }
  return Object.freeze(port)
}
