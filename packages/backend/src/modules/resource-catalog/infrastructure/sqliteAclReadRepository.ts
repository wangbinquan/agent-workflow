import type { AclResourceType } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { AclRow } from '../domain/resourceAccess'
import type {
  ResourceCatalogAclIdentityReadPort,
  ResourceCatalogAclSnapshotReadPort,
} from '../application/ports/providerResourceCatalogPersistence'
import { isSqliteAclResourceType, SQLITE_ACL_TABLES } from './sqliteAclRegistry'
import { loadGrantLevelInTx } from './sqliteResourceGrantRepository'

function sqliteAclTable(type: AclResourceType) {
  if (!isSqliteAclResourceType(type)) {
    throw new Error(`ACL identity persistence is required for ${type}`)
  }
  return SQLITE_ACL_TABLES[type]
}

export interface AclResourceIdentitySnapshot extends AclRow {
  readonly name: string
  readonly aclRevision: number
}

export async function findOwnedAclResourceIdsByName(
  db: DbClient,
  type: AclResourceType,
  ownerUserId: string,
  name: string,
): Promise<string[]> {
  const table = sqliteAclTable(type)
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.name, name), eq(table.ownerUserId, ownerUserId)))
  return rows.map((row) => row.id)
}

export async function loadAclResourceNamesByIds(
  db: DbClient,
  type: AclResourceType,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const table = sqliteAclTable(type)
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(inArray(table.id, [...ids]))
  return new Map(rows.map((row) => [row.id, row.name]))
}

export async function getAclResourceOwner(
  db: DbClient,
  type: AclResourceType,
  id: string,
): Promise<string | null | undefined> {
  const table = sqliteAclTable(type)
  const rows = await db
    .select({ ownerUserId: table.ownerUserId })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  return rows[0]?.ownerUserId
}

export function getAclResourceOwnerInTx(
  tx: DbTxSync,
  type: AclResourceType,
  id: string,
): string | null | undefined {
  const table = sqliteAclTable(type)
  return tx.select({ ownerUserId: table.ownerUserId }).from(table).where(eq(table.id, id)).get()
    ?.ownerUserId
}

export async function listOwnedAclResourceNames(
  db: DbClient,
  type: AclResourceType,
  ownerUserId: string,
): Promise<string[]> {
  const table = sqliteAclTable(type)
  const rows = await db
    .select({ name: table.name })
    .from(table)
    .where(eq(table.ownerUserId, ownerUserId))
  return rows.map((row) => row.name)
}

export async function getAclResourceAccessRow(
  db: DbClient,
  type: AclResourceType,
  id: string,
): Promise<AclRow | null> {
  const table = sqliteAclTable(type)
  const rows = await db
    .select({
      id: table.id,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
    })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  return rows[0] ?? null
}

export function getAclResourceAccessRowInTx(
  tx: DbTxSync,
  type: AclResourceType,
  id: string,
): AclRow | null {
  const table = sqliteAclTable(type)
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
  const table = sqliteAclTable(type)
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
  const table = sqliteAclTable(type)
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

export async function listAclResourceIdentityRowsByIds(
  db: DbClient,
  type: AclResourceType,
  ids: readonly string[],
): Promise<AclResourceIdentitySnapshot[]> {
  if (ids.length === 0) return []
  const table = sqliteAclTable(type)
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

export function listAclResourceIdentityRowsByNamesInTx(
  tx: DbTxSync,
  type: AclResourceType,
  names: readonly string[],
): AclResourceIdentitySnapshot[] {
  if (names.length === 0) return []
  const table = sqliteAclTable(type)
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

export async function listAclResourceIdentityRowsByNames(
  db: DbClient,
  type: AclResourceType,
  names: readonly string[],
): Promise<AclResourceIdentitySnapshot[]> {
  if (names.length === 0) return []
  const table = sqliteAclTable(type)
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

/** Internal provider-neutral owner/name reads used by Intent apply preflight. */
export function createSqliteResourceCatalogAclIdentityReadPort(
  db: DbClient,
): ResourceCatalogAclIdentityReadPort {
  const port: ResourceCatalogAclIdentityReadPort = {
    getOwner: (type, id) => getAclResourceOwner(db, type, id),
    listOwnedNames: (type, ownerUserId) => listOwnedAclResourceNames(db, type, ownerUserId),
  }
  return Object.freeze(port)
}

export function createSqliteResourceCatalogAclSnapshotReadPort(
  transaction: DbTxSync,
): ResourceCatalogAclSnapshotReadPort {
  const port: ResourceCatalogAclSnapshotReadPort = {
    getAccessRow: (type, resourceId) => getAclResourceAccessRowInTx(transaction, type, resourceId),
    getGrantLevel: (type, resourceId, userId) =>
      loadGrantLevelInTx(transaction, type, resourceId, userId),
  }
  return Object.freeze(port)
}
