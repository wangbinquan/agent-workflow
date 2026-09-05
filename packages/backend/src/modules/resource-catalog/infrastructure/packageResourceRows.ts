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
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  ResourcePackageOwnedResourceLookupPort,
  ResourcePackageReadPort,
  ResourcePackageResourceSnapshot,
} from '../application/package/ports'
import { ACL_TABLES } from './aclRegistry'
import { createResourceGrantReadPort } from './resourceVisibility'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

/**
 * RFC-359 W4-D20 —— 资源包传输边界的 owner/name 查找与预览 / 导出读模型：一份实现，两个 provider 共用。
 * 此前 `sqlitePackageResourceRows.ts` 与 `postgresqlPackageResourceRows.ts` 各一份（前者另有两个零消费导出
 * 与四个只服务 legacy 提交路径的同步助手，那四个仍留在 SQLite 命名的文件里，随 legacy 提交路径退役）。
 */
export function createResourcePackageOwnedResourceLookup(
  db: ProviderNeutralDatabase,
): ResourcePackageOwnedResourceLookupPort {
  const port: ResourcePackageOwnedResourceLookupPort = {
    async findOwnedIdsByName(input) {
      const table = ACL_TABLES[input.kind]
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.ownerUserId, input.ownerUserId), eq(table.name, input.name)))
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

async function packageWorkgroupMembers(
  db: ResourceCatalogTransaction,
  workgroupIds: readonly string[],
): Promise<ReadonlyMap<string, readonly PackageWorkgroupMemberDocument[]>> {
  if (workgroupIds.length === 0) return new Map()
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(inArray(workgroupMembers.workgroupId, [...workgroupIds]))
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

async function packageSnapshots(
  db: ResourceCatalogTransaction,
  type: BundleResourceType,
  rows: readonly PackageResourceRow[],
): Promise<readonly ResourcePackageResourceSnapshot[]> {
  const membersByWorkgroup =
    type === 'workgroup'
      ? await packageWorkgroupMembers(
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

async function listPackageRowsByIds(
  db: ResourceCatalogTransaction,
  type: BundleResourceType,
  ids: readonly string[],
  orderById: boolean,
): Promise<readonly PackageResourceRow[]> {
  if (ids.length === 0) return []
  const table = ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.id, [...ids]))
  return orderById ? await query.orderBy(asc(table.id)) : await query
}

async function listPackageRowsByNames(
  db: ResourceCatalogTransaction,
  type: BundleResourceType,
  names: readonly string[],
  orderById: boolean,
): Promise<readonly PackageResourceRow[]> {
  if (names.length === 0) return []
  const table = ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.name, [...names]))
  return orderById ? await query.orderBy(asc(table.id)) : await query
}

/** 预览 / 导出读模型。 */
export function createResourcePackageReadPort(
  db: ProviderNeutralDatabase,
): ResourcePackageReadPort {
  const grants = createResourceGrantReadPort(db)
  const port: ResourcePackageReadPort = {
    async listByIds(type, ids, options = {}) {
      return runResourceCatalogTransaction(db, async (transaction) =>
        packageSnapshots(
          transaction,
          type,
          await listPackageRowsByIds(transaction, type, ids, options.orderById === true),
        ),
      )
    },
    async listByNames(type, names, options = {}) {
      return runResourceCatalogTransaction(db, async (transaction) =>
        packageSnapshots(
          transaction,
          type,
          await listPackageRowsByNames(transaction, type, names, options.orderById === true),
        ),
      )
    },
    async getById(type, id) {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const rows = await listPackageRowsByIds(transaction, type, [id], false)
        const snapshots = await packageSnapshots(transaction, type, rows)
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
      return rows
        .filter((row) => row.status === 'active')
        .map((row) => Object.freeze({ username: row.username, userId: row.id }))
    },
  }
  return Object.freeze(port)
}
