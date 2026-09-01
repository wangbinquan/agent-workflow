import type { AclResourceType } from '@agent-workflow/shared'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  actionTemplates,
  agents,
  automationPolicies,
  capabilityTemplates,
  digitalEmployees,
  mcps,
  plugins,
  skills,
  verificationProfiles,
  workflows,
  workgroups,
} from '@/db/schema'
import type { ResourceCatalogOwnedAclType } from '../application/ports/providerResourceCatalogPersistence'

export type SqliteAclResourceType = ResourceCatalogOwnedAclType

/** RFC-345 D4 — the canonical ACL roster's SQLite-only table registry. */
export const SQLITE_ACL_TABLES = {
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
} as const

export type SqliteAclTableFor<K extends SqliteAclResourceType> = (typeof SQLITE_ACL_TABLES)[K]

export function isSqliteAclResourceType(type: AclResourceType): type is SqliteAclResourceType {
  return type in SQLITE_ACL_TABLES
}

const SQLITE_OWNER_NAME_UNIQUE_PARTITIONS = {
  agent: () => ({}),
  skill: () => ({}),
  mcp: () => ({}),
  plugin: () => ({}),
  workgroup: () => ({}),
  capability_template: () => ({}),
  action_template: () => ({}),
  verification_profile: () => ({}),
  digital_employee: () => ({}),
  automation_policy: () => ({}),
} satisfies {
  readonly [K in SqliteAclResourceType]?: (
    table: (typeof SQLITE_ACL_TABLES)[K],
  ) => Readonly<Record<string, SQLiteColumn>>
}

export const SQLITE_OWNER_NAME_UNIQUE_TYPES: ReadonlySet<SqliteAclResourceType> = new Set(
  Object.keys(SQLITE_OWNER_NAME_UNIQUE_PARTITIONS) as SqliteAclResourceType[],
)

export function sqliteOwnerNamePartitionOf(
  type: SqliteAclResourceType,
): Readonly<Record<string, SQLiteColumn>> {
  const select = (
    SQLITE_OWNER_NAME_UNIQUE_PARTITIONS as unknown as Partial<
      Record<SqliteAclResourceType, (table: SQLiteTable) => Readonly<Record<string, SQLiteColumn>>>
    >
  )[type]
  return select === undefined ? {} : select(SQLITE_ACL_TABLES[type])
}
