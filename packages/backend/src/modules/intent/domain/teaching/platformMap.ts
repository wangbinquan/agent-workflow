// RFC-348 D3 — platform capability map: every ACL resource type, with the
// intent builder's stance on it.
//
// The changeset contract only creates / updates the six `INTENT_RESOURCE_TYPES`;
// the other nine ACL types exist on the platform and are visible to the model
// as read-only inventory (`inventory/platform/<type>.md`, see
// services/intent/platformInventory.ts) so it can say WHERE a user configures
// one instead of inventing a changeset op for it. `satisfies
// Record<AclResourceType, …>` makes a new ACL type fail to compile until it
// declares a stance here; tests lock `intent-creatable` ⇔ `INTENT_RESOURCE_TYPES`
// and every `route` path against the frontend route table.

import type { AclResourceType } from '@agent-workflow/shared'

export type IntentPlatformResourceTeaching =
  | { readonly stance: 'intent-creatable' }
  | {
      readonly stance: 'platform-only'
      /** One clause, model-facing: what the thing is. */
      readonly purpose: string
      readonly managedAt:
        | { readonly kind: 'route'; readonly path: string }
        | { readonly kind: 'api-only'; readonly note: string }
    }

export const INTENT_PLATFORM_RESOURCE_MAP = {
  agent: { stance: 'intent-creatable' },
  skill: { stance: 'intent-creatable' },
  mcp: { stance: 'intent-creatable' },
  plugin: { stance: 'intent-creatable' },
  workflow: { stance: 'intent-creatable' },
  workgroup: { stance: 'intent-creatable' },
  capability_template: {
    stance: 'platform-only',
    purpose: 'code-capability template: the frozen stage sequence a code round runs',
    managedAt: {
      kind: 'api-only',
      note: 'no dedicated page; created by code missions (/code/missions) via /api/capability-templates',
    },
  },
  digital_employee: {
    stance: 'platform-only',
    purpose: 'digital employee type configuration',
    managedAt: { kind: 'route', path: '/code/config/employees' },
  },
  action_template: {
    stance: 'platform-only',
    purpose: 'digital-employee action template',
    managedAt: { kind: 'route', path: '/code/config/action-templates' },
  },
  verification_profile: {
    stance: 'platform-only',
    purpose: 'verification program profile applied to employee results',
    managedAt: { kind: 'route', path: '/code/config/verification-profiles' },
  },
  automation_policy: {
    stance: 'platform-only',
    purpose: 'when and how digital employees act automatically',
    managedAt: { kind: 'route', path: '/code/policies' },
  },
  development_adapter: {
    stance: 'platform-only',
    purpose: 'executor / development adapter connecting employees to code hosts and tooling',
    managedAt: { kind: 'route', path: '/digital-employees' },
  },
  employee_definition: {
    stance: 'platform-only',
    purpose: 'digital-employee OS employee definition',
    managedAt: { kind: 'route', path: '/digital-employees' },
  },
  employee_tool: {
    stance: 'platform-only',
    purpose: 'digital-employee OS tool registration',
    managedAt: { kind: 'route', path: '/digital-employees' },
  },
  employee_job_template: {
    stance: 'platform-only',
    purpose: 'digital-employee OS job template',
    managedAt: { kind: 'route', path: '/digital-employees' },
  },
} as const satisfies Record<AclResourceType, IntentPlatformResourceTeaching>

export type PlatformOnlyResourceType = {
  [K in AclResourceType]: (typeof INTENT_PLATFORM_RESOURCE_MAP)[K] extends {
    stance: 'platform-only'
  }
    ? K
    : never
}[AclResourceType]

/** The platform-only types in roster order (stable for rendering + inventory files). */
export function platformOnlyResourceTypes(): readonly PlatformOnlyResourceType[] {
  return (Object.keys(INTENT_PLATFORM_RESOURCE_MAP) as AclResourceType[]).filter(
    (type): type is PlatformOnlyResourceType =>
      INTENT_PLATFORM_RESOURCE_MAP[type].stance === 'platform-only',
  )
}
