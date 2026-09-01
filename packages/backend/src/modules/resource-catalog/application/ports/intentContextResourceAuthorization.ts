import type { ResourceGrantLevel, ResourceVisibility } from '@agent-workflow/shared'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'

export interface IntentContextResourceAuthorizationRow {
  readonly resourceType: CatalogSelectorKind
  readonly resourceId: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
}

/** Provider-transaction-bound reads used by one Intent context session. */
export interface IntentContextResourceAuthorizationReadPort {
  loadIdentity(
    resourceType: CatalogSelectorKind,
    resourceId: string,
  ): Promise<IntentContextResourceAuthorizationRow | null>
  loadGrantLevel(
    resourceType: CatalogSelectorKind,
    resourceId: string,
    userId: string,
  ): Promise<ResourceGrantLevel | null>
}

/** SQLite-only transaction reads that never escape a synchronous tx body. */
export interface IntentContextResourceAuthorizationSyncReadPort {
  loadIdentity(
    resourceType: CatalogSelectorKind,
    resourceId: string,
  ): IntentContextResourceAuthorizationRow | null
  loadGrantLevel(
    resourceType: CatalogSelectorKind,
    resourceId: string,
    userId: string,
  ): ResourceGrantLevel | null
}
