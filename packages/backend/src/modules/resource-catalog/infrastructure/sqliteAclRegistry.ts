import type { AclResourceType } from '@agent-workflow/shared'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  actionTemplates,
  agents,
  automationPolicies,
  capabilityTemplates,
  developmentAdapterDefinitions,
  digitalEmployees,
  employeeDefinitions,
  employeeJobTemplates,
  employeeToolRegistrations,
  mcps,
  plugins,
  skills,
  verificationProfiles,
  workflows,
  workgroups,
} from '@/db/schema'

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
  development_adapter: developmentAdapterDefinitions,
  employee_definition: employeeDefinitions,
  employee_tool: employeeToolRegistrations,
  employee_job_template: employeeJobTemplates,
} as const

export type SqliteAclTableFor<K extends AclResourceType> = (typeof SQLITE_ACL_TABLES)[K]

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
  development_adapter: () => ({}),
  employee_definition: () => ({}),
  employee_job_template: (table: typeof employeeJobTemplates) => ({
    typeId: table.typeId,
    typeRevision: table.typeRevision,
  }),
} satisfies {
  readonly [K in AclResourceType]?: (
    table: (typeof SQLITE_ACL_TABLES)[K],
  ) => Readonly<Record<string, SQLiteColumn>>
}

export const SQLITE_OWNER_NAME_UNIQUE_TYPES: ReadonlySet<AclResourceType> = new Set(
  Object.keys(SQLITE_OWNER_NAME_UNIQUE_PARTITIONS) as AclResourceType[],
)

export function sqliteOwnerNamePartitionOf(
  type: AclResourceType,
): Readonly<Record<string, SQLiteColumn>> {
  const select = (
    SQLITE_OWNER_NAME_UNIQUE_PARTITIONS as unknown as Partial<
      Record<AclResourceType, (table: SQLiteTable) => Readonly<Record<string, SQLiteColumn>>>
    >
  )[type]
  return select === undefined ? {} : select(SQLITE_ACL_TABLES[type])
}
