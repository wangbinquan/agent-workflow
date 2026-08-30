import {
  ACL_RESOURCE_TYPES,
  BUNDLE_RESOURCE_TYPES,
  GRANT_RESOURCE_TYPES,
  INTENT_RESOURCE_TYPES,
  asBundleResourceType,
  asIntentResourceType,
  type AclResourceType,
  type BundleResourceType,
  type GrantResourceType,
  type IntentResourceType,
} from '@agent-workflow/shared'

// RFC-345 D1 — four independent rosters. These aliases retain the canonical
// tuple objects; they are not copied literals and therefore cannot drift.
export const ACL_CATALOG_KINDS = ACL_RESOURCE_TYPES
export const GRANT_TARGET_KINDS = GRANT_RESOURCE_TYPES
export const PACKAGE_RESOURCE_KINDS = BUNDLE_RESOURCE_TYPES
export const CATALOG_SELECTOR_KINDS = INTENT_RESOURCE_TYPES

export type AclCatalogKind = AclResourceType
export type GrantTargetKind = GrantResourceType
export type PackageResourceKind = BundleResourceType
export type CatalogSelectorKind = IntentResourceType

/** The named ACL -> package narrowing point; null means “not packageable”. */
export const asPackageResourceKind = asBundleResourceType

/** The named ACL -> selector narrowing point; null means “not selectable”. */
export const asCatalogSelectorKind = asIntentResourceType

/** Grant targets add scheduled_task, so callers must narrow before ACL use. */
export function asAclCatalogKind(value: GrantTargetKind): AclCatalogKind | null {
  return (ACL_CATALOG_KINDS as readonly string[]).includes(value) ? (value as AclCatalogKind) : null
}
