import type { CatalogSelectorKind } from './resourceKinds'

export interface ResourceSummaryRevisionByKind {
  readonly agent: {
    readonly kind: 'agent'
    readonly updatedAt: number
    readonly aclRevision: number
  }
  readonly skill: { readonly kind: 'skill'; readonly token: string }
  readonly mcp: { readonly kind: 'mcp'; readonly configHash: string }
  readonly plugin: { readonly kind: 'plugin'; readonly configHash: string }
  readonly workflow: { readonly kind: 'workflow'; readonly version: number }
  readonly workgroup: { readonly kind: 'workgroup'; readonly version: number }
}

/** Equality-only catalog projection; aggregate commands keep their exact fences. */
export type ResourceSummaryRevision<K extends CatalogSelectorKind = CatalogSelectorKind> =
  ResourceSummaryRevisionByKind[K]

export function resourceSummaryRevisionEquals(
  left: ResourceSummaryRevision,
  right: ResourceSummaryRevision,
): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'agent': {
      const other = right as ResourceSummaryRevisionByKind['agent']
      return left.updatedAt === other.updatedAt && left.aclRevision === other.aclRevision
    }
    case 'skill':
      return left.token === (right as ResourceSummaryRevisionByKind['skill']).token
    case 'mcp':
      return left.configHash === (right as ResourceSummaryRevisionByKind['mcp']).configHash
    case 'plugin':
      return left.configHash === (right as ResourceSummaryRevisionByKind['plugin']).configHash
    case 'workflow':
      return left.version === (right as ResourceSummaryRevisionByKind['workflow']).version
    case 'workgroup':
      return left.version === (right as ResourceSummaryRevisionByKind['workgroup']).version
  }
}
