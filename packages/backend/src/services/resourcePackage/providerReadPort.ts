import type { BundleResourceType, ResourceVisibility } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ValidationError } from '@/util/errors'

/**
 * Structural W6 compatibility face. The provider is bound by Resource Catalog
 * composition (or by the focused test helper); this legacy algorithm layer
 * never imports a database or a bounded-context internal adapter.
 */
export interface ResourcePackageResourceSnapshot {
  readonly type: BundleResourceType
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly builtin: boolean
  readonly document: string
}

export interface ResourcePackageReadPort {
  listByIds(
    type: BundleResourceType,
    ids: readonly string[],
    options?: Readonly<{ orderById?: boolean }>,
  ): Promise<readonly ResourcePackageResourceSnapshot[]>
  listByNames(
    type: BundleResourceType,
    names: readonly string[],
    options?: Readonly<{ orderById?: boolean }>,
  ): Promise<readonly ResourcePackageResourceSnapshot[]>
  getById(
    type: BundleResourceType,
    id: string,
  ): Promise<ResourcePackageResourceSnapshot | undefined>
  listGrantedResourceIds(actor: Actor, type: BundleResourceType): Promise<ReadonlySet<string>>
  findActiveUsersByUsername(
    usernames: readonly string[],
  ): Promise<readonly Readonly<{ username: string; userId: string }>[]>
}

/** Decode the private provider document at the legacy algorithm edge. */
export function resourcePackageDocumentOf(
  snapshot: ResourcePackageResourceSnapshot,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot.document)
  } catch {
    throw new ValidationError(
      'package-resource-snapshot-invalid',
      `stored ${snapshot.type} '${snapshot.id}' has an invalid package document`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(
      'package-resource-snapshot-invalid',
      `stored ${snapshot.type} '${snapshot.id}' has a non-object package document`,
    )
  }
  return {
    ...parsed,
    id: snapshot.id,
    name: snapshot.name,
    ownerUserId: snapshot.ownerUserId,
    visibility: snapshot.visibility,
    builtin: snapshot.builtin,
  }
}
