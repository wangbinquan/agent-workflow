import type { ResourceAclActorProjection } from '../../domain/resourceAccess'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'

/** Provider-owned count projection; rows and query builders never cross it. */
export interface ResourceCatalogOverviewCountPort {
  countVisible(
    actor: ResourceAclActorProjection,
    kind: CatalogSelectorKind,
    options: Readonly<{ excludeBuiltin: boolean }>,
  ): Promise<number>
}
