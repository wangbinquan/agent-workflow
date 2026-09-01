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

/** PostgreSQL owns a distinct roster even though both dialects share logical ids. */
export const POSTGRESQL_ACL_TABLES = {
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
} as const satisfies Readonly<Record<ResourceCatalogOwnedAclType, object>>

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
