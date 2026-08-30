import type {
  AclCatalogKind,
  CatalogSelectorKind,
  GrantTargetKind,
  PackageResourceKind,
} from './resourceKinds'

/** Identity-only resource reference over the largest canonical target roster. */
export interface ResourceRef<K extends GrantTargetKind = GrantTargetKind> {
  readonly kind: K
  readonly id: string
}

export type AclResourceRef<K extends AclCatalogKind = AclCatalogKind> = ResourceRef<K>
export type GrantTargetRef<K extends GrantTargetKind = GrantTargetKind> = ResourceRef<K>
export type PackageResourceRef<K extends PackageResourceKind = PackageResourceKind> = ResourceRef<K>
export type CatalogResourceRef<K extends CatalogSelectorKind = CatalogSelectorKind> = ResourceRef<K>

export function resourceRef<K extends GrantTargetKind>(kind: K, id: string): ResourceRef<K> {
  return Object.freeze({ kind, id })
}
