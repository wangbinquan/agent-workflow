import type { BundleResourceType } from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { users, workgroupMembers } from '@/db/schema'
import type {
  agents,
  capabilityTemplates,
  mcps,
  plugins,
  skills,
  workflows,
  workgroups,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  ResourcePackageOwnedResourceLookupPort,
  ResourcePackageReadPort,
  ResourcePackageResourceSnapshot,
} from '../application/package/ports'
import { POSTGRESQL_ACL_TABLES } from './postgresqlAclRegistry'
import { createPostgresqlResourceGrantReadPort } from './postgresqlResourceGrantRepository'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

/** PostgreSQL owner/name lookup for the ResourcePackage transport boundary. */
export function createPostgresqlResourcePackageOwnedResourceLookup(
  db: PostgresqlDatabaseClient,
): ResourcePackageOwnedResourceLookupPort {
  const port: ResourcePackageOwnedResourceLookupPort = {
    async findOwnedIdsByName(input) {
      const table = POSTGRESQL_ACL_TABLES[input.kind]
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.ownerUserId, input.ownerUserId), eq(table.name, input.name)))
        .all()
      return rows.map((row) => row.id)
    },
  }
  return Object.freeze(port)
}

type PackageResourceRow =
  | typeof agents.$inferSelect
  | typeof skills.$inferSelect
  | typeof mcps.$inferSelect
  | typeof plugins.$inferSelect
  | typeof workflows.$inferSelect
  | typeof workgroups.$inferSelect
  | typeof capabilityTemplates.$inferSelect

interface PackageWorkgroupMemberDocument {
  readonly id: string
  readonly memberType: string
  readonly agentId: string | null
  readonly agentName: string | null
  readonly userId: string | null
  readonly username: string | null
  readonly displayName: string
  readonly roleDesc: string
  readonly sortOrder: number
}

async function postgresqlWorkgroupMembers(
  db: PostgresqlResourceCatalogTransaction,
  workgroupIds: readonly string[],
): Promise<ReadonlyMap<string, readonly PackageWorkgroupMemberDocument[]>> {
  if (workgroupIds.length === 0) return new Map()
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(inArray(workgroupMembers.workgroupId, [...workgroupIds]))
    .orderBy(asc(workgroupMembers.sortOrder), asc(workgroupMembers.id))
    .all()
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
      .all()
    for (const user of userRows) usernameById.set(user.id, user.username)
  }
  const byWorkgroup = new Map<string, PackageWorkgroupMemberDocument[]>()
  for (const member of members) {
    const grouped = byWorkgroup.get(member.workgroupId) ?? []
    grouped.push(
      Object.freeze({
        id: member.id,
        memberType: member.memberType,
        agentId: member.agentId,
        agentName: member.agentName,
        userId: member.userId,
        username: member.userId === null ? null : (usernameById.get(member.userId) ?? null),
        displayName: member.displayName,
        roleDesc: member.roleDesc,
        sortOrder: member.sortOrder,
      }),
    )
    byWorkgroup.set(member.workgroupId, grouped)
  }
  return byWorkgroup
}

async function postgresqlSnapshots(
  db: PostgresqlResourceCatalogTransaction,
  type: BundleResourceType,
  rows: readonly PackageResourceRow[],
): Promise<readonly ResourcePackageResourceSnapshot[]> {
  const membersByWorkgroup =
    type === 'workgroup'
      ? await postgresqlWorkgroupMembers(
          db,
          rows.map((row) => row.id),
        )
      : new Map<string, readonly PackageWorkgroupMemberDocument[]>()
  return rows.map((row) => {
    const document =
      type === 'workgroup' ? { ...row, members: membersByWorkgroup.get(row.id) ?? [] } : row
    return Object.freeze({
      type,
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      visibility: row.visibility,
      builtin: 'builtin' in row && row.builtin === true,
      document: JSON.stringify(document),
    })
  })
}

async function listPostgresqlPackageRowsByIds(
  db: PostgresqlResourceCatalogTransaction,
  type: BundleResourceType,
  ids: readonly string[],
  orderById: boolean,
): Promise<readonly PackageResourceRow[]> {
  if (ids.length === 0) return []
  const table = POSTGRESQL_ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.id, [...ids]))
  return orderById ? await query.orderBy(asc(table.id)).all() : await query.all()
}

async function listPostgresqlPackageRowsByNames(
  db: PostgresqlResourceCatalogTransaction,
  type: BundleResourceType,
  names: readonly string[],
  orderById: boolean,
): Promise<readonly PackageResourceRow[]> {
  if (names.length === 0) return []
  const table = POSTGRESQL_ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.name, [...names]))
  return orderById ? await query.orderBy(asc(table.id)).all() : await query.all()
}

/** PostgreSQL implementation of the package preview/export read model. */
export function createPostgresqlResourcePackageReadPort(
  db: PostgresqlDatabaseClient,
): ResourcePackageReadPort {
  const grants = createPostgresqlResourceGrantReadPort(db)
  const port: ResourcePackageReadPort = {
    async listByIds(type, ids, options = {}) {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) =>
        postgresqlSnapshots(
          transaction,
          type,
          await listPostgresqlPackageRowsByIds(transaction, type, ids, options.orderById === true),
        ),
      )
    },
    async listByNames(type, names, options = {}) {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) =>
        postgresqlSnapshots(
          transaction,
          type,
          await listPostgresqlPackageRowsByNames(
            transaction,
            type,
            names,
            options.orderById === true,
          ),
        ),
      )
    },
    async getById(type, id) {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const rows = await listPostgresqlPackageRowsByIds(transaction, type, [id], false)
        const snapshots = await postgresqlSnapshots(transaction, type, rows)
        return snapshots[0]
      })
    },
    listGrantedResourceIds: (actor, type) => grants.listGrantedResourceIds(actor, type),
    async findActiveUsersByUsername(usernames) {
      if (usernames.length === 0) return []
      const rows = await db
        .select({ id: users.id, username: users.username, status: users.status })
        .from(users)
        .where(inArray(users.username, [...usernames]))
        .all()
      return rows
        .filter((row) => row.status === 'active')
        .map((row) => Object.freeze({ username: row.username, userId: row.id }))
    },
  }
  return Object.freeze(port)
}
