import type { Actor } from '@/auth/actor'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'

/** Provider-owned count projection; rows and query builders never cross it. */
export interface ResourceCatalogOverviewCountPort {
  countVisible(
    actor: Actor,
    kind: CatalogSelectorKind,
    options: Readonly<{ excludeBuiltin: boolean }>,
  ): Promise<number>
}
