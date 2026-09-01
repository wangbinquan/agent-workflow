import type { BundleResourceType } from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { users, workgroupMembers } from '@/db/schema'
import type {
  ResourcePackageOwnedResourceLookupPort,
  ResourcePackageReadPort,
  ResourcePackageResourceSnapshot,
} from '../application/package/ports'
import { createSqliteResourceGrantReadPort } from './sqliteResourceGrantRepository'
import { SQLITE_ACL_TABLES } from './sqliteAclRegistry'

/**
 * Transitional T6 adapter for package characterization paths that still need
 * aggregate rows. It keeps dynamic SQLite table selection inside
 * infrastructure; the seven typed package participants replace these raw-row
 * reads when their aggregate cohorts cut over.
 */
export type SqlitePackageResourceRow = Record<string, unknown>

export async function listSqlitePackageResourceRowsByIds(
  db: DbClient,
  type: BundleResourceType,
  ids: readonly string[],
  options: { readonly orderById?: boolean } = {},
): Promise<SqlitePackageResourceRow[]> {
  if (ids.length === 0) return []
  const table = SQLITE_ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.id, [...ids]))
  const rows = options.orderById === true ? await query.orderBy(asc(table.id)) : await query
  return rows as unknown as SqlitePackageResourceRow[]
}

export async function listSqlitePackageResourceRowsByNames(
  db: DbClient,
  type: BundleResourceType,
  names: readonly string[],
  options: { readonly orderById?: boolean } = {},
): Promise<SqlitePackageResourceRow[]> {
  if (names.length === 0) return []
  const table = SQLITE_ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.name, [...names]))
  const rows = options.orderById === true ? await query.orderBy(asc(table.id)) : await query
  return rows as unknown as SqlitePackageResourceRow[]
}

export async function getSqlitePackageResourceRow(
  db: DbClient,
  type: BundleResourceType,
  id: string,
): Promise<SqlitePackageResourceRow | undefined> {
  const table = SQLITE_ACL_TABLES[type]
  return (await db.select().from(table).where(eq(table.id, id)).get()) as
    | SqlitePackageResourceRow
    | undefined
}

export function getSqlitePackageResourceRowInTx(
  tx: DbTxSync,
  type: BundleResourceType,
  id: string,
): SqlitePackageResourceRow | undefined {
  const table = SQLITE_ACL_TABLES[type]
  return tx.select().from(table).where(eq(table.id, id)).get() as
    | SqlitePackageResourceRow
    | undefined
}

type SeededBuiltinResourceType = 'agent' | 'workflow'

function builtinColumnOf(type: SeededBuiltinResourceType): AnySQLiteColumn {
  return SQLITE_ACL_TABLES[type].builtin
}

export async function findSqliteBuiltinResource(
  db: DbClient,
  type: SeededBuiltinResourceType,
  name: string,
): Promise<{ readonly id: string; readonly name: string } | undefined> {
  const table = SQLITE_ACL_TABLES[type]
  return (await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.name, name), eq(builtinColumnOf(type), true)))
    .get()) as { id: string; name: string } | undefined
}

export function findSqliteBuiltinResourceInTx(
  tx: DbTxSync,
  type: SeededBuiltinResourceType,
  name: string,
): { readonly id: string; readonly name: string } | undefined {
  const table = SQLITE_ACL_TABLES[type]
  return tx
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.name, name), eq(builtinColumnOf(type), true)))
    .get() as { id: string; name: string } | undefined
}

export function createSqliteResourcePackageOwnedResourceLookup(
  db: DbClient,
): ResourcePackageOwnedResourceLookupPort {
  const port: ResourcePackageOwnedResourceLookupPort = {
    async findOwnedIdsByName(input) {
      const table = SQLITE_ACL_TABLES[input.kind]
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.ownerUserId, input.ownerUserId), eq(table.name, input.name)))
      return rows.map((row) => row.id)
    },
  }
  return Object.freeze(port)
}

async function attachSqliteWorkgroupMembers(
  db: DbClient,
  rows: SqlitePackageResourceRow[],
): Promise<void> {
  if (rows.length === 0) return
  const workgroupIds = rows.map((row) => String(row.id))
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(inArray(workgroupMembers.workgroupId, workgroupIds))
    .orderBy(asc(workgroupMembers.sortOrder), asc(workgroupMembers.id))
  const userIds = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'human' && member.userId !== null ? [member.userId] : [],
      ),
    ),
  ]
  const usernameById = new Map<string, string>()
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, userIds))
    for (const user of userRows) usernameById.set(user.id, user.username)
  }
  const membersByWorkgroup = new Map<string, Array<Record<string, unknown>>>()
  for (const member of members) {
    const grouped = membersByWorkgroup.get(member.workgroupId) ?? []
    grouped.push({
      id: member.id,
      memberType: member.memberType,
      agentId: member.agentId,
      agentName: member.agentName,
      userId: member.userId,
      username: member.userId === null ? null : (usernameById.get(member.userId) ?? null),
      displayName: member.displayName,
      roleDesc: member.roleDesc,
      sortOrder: member.sortOrder,
    })
    membersByWorkgroup.set(member.workgroupId, grouped)
  }
  for (const row of rows) row.members = membersByWorkgroup.get(String(row.id)) ?? []
}

function sqliteSnapshot(
  type: BundleResourceType,
  row: SqlitePackageResourceRow,
): ResourcePackageResourceSnapshot {
  return Object.freeze({
    type,
    id: String(row.id),
    name: String(row.name),
    ownerUserId: typeof row.ownerUserId === 'string' ? row.ownerUserId : null,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    builtin: row.builtin === true,
    document: JSON.stringify(row),
  })
}

async function sqliteSnapshots(
  db: DbClient,
  type: BundleResourceType,
  rows: SqlitePackageResourceRow[],
): Promise<ResourcePackageResourceSnapshot[]> {
  if (type === 'workgroup') await attachSqliteWorkgroupMembers(db, rows)
  return rows.map((row) => sqliteSnapshot(type, row))
}

/** SQLite implementation of the provider-neutral package preview/export read model. */
export function createSqliteResourcePackageReadPort(db: DbClient): ResourcePackageReadPort {
  const grants = createSqliteResourceGrantReadPort(db)
  const port: ResourcePackageReadPort = {
    async listByIds(type, ids, options = {}) {
      return sqliteSnapshots(
        db,
        type,
        await listSqlitePackageResourceRowsByIds(db, type, ids, options),
      )
    },
    async listByNames(type, names, options = {}) {
      return sqliteSnapshots(
        db,
        type,
        await listSqlitePackageResourceRowsByNames(db, type, names, options),
      )
    },
    async getById(type, id) {
      const row = await getSqlitePackageResourceRow(db, type, id)
      if (row === undefined) return undefined
      return (await sqliteSnapshots(db, type, [row]))[0]
    },
    listGrantedResourceIds: (actor, type) => grants.listGrantedResourceIds(actor, type),
    async findActiveUsersByUsername(usernames) {
      if (usernames.length === 0) return []
      const rows = await db
        .select({ id: users.id, username: users.username, status: users.status })
        .from(users)
        .where(inArray(users.username, [...usernames]))
      return rows
        .filter((row) => row.status === 'active')
        .map((row) => Object.freeze({ username: row.username, userId: row.id }))
    },
  }
  return Object.freeze(port)
}
