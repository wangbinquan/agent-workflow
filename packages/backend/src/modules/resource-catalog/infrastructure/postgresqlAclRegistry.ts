import type { ResourceCatalogOwnedAclType } from '../application/ports/providerResourceCatalogPersistence'
import { ACL_TABLES } from './resourceVisibility'

/** RFC-359 W4-B2：表注册只有一份（resourceVisibility.ts）；这里只是 PG 侧原子沿用的名字。 */
export const POSTGRESQL_ACL_TABLES = ACL_TABLES

export const POSTGRESQL_OWNER_NAME_UNIQUE_TYPES: ReadonlySet<ResourceCatalogOwnedAclType> = new Set(
  [
    'agent',
    'skill',
    'mcp',
    'plugin',
    'workgroup',
    'capability_template',
    'action_template',
    'verification_profile',
    'digital_employee',
    'automation_policy',
  ],
)

export const POSTGRESQL_OWNER_NAME_UNIQUE_CONSTRAINTS = [
  'agents_owner_name_unique',
  'skills_owner_name_unique',
  'mcps_owner_name_unique',
  'plugins_owner_name_unique',
  'workgroups_owner_name_unique',
  'capability_templates_owner_name_unique',
  'action_templates_owner_name_unique',
  'verification_profiles_owner_name_unique',
  'digital_employees_owner_name_unique',
  'automation_policies_owner_name_unique',
] as const
