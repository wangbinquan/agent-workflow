import type {
  AclResourceType,
  ResourceGrantLevel,
  ResourceVisibility,
  UserPublic,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { AclRow } from '../../domain/resourceAccess'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'
import type { ResourceSummary } from '../../public/types'

/** ACL identity tables whose aggregate writer belongs to resource-catalog. */
export type ResourceCatalogOwnedAclType = Exclude<
  AclResourceType,
  'development_adapter' | 'employee_definition' | 'employee_tool' | 'employee_job_template'
>

/** Provider-bound grant reads used by the resource authorization application. */
export interface ResourceCatalogGrantReadPort {
  listGrantedResourceIds(actor: Actor, type: AclResourceType): Promise<ReadonlySet<string>>
  loadGrantLevel(
    type: AclResourceType,
    resourceId: string,
    userId: string,
  ): Promise<ResourceGrantLevel | null>
  loadGrantLevelsForUser(
    type: AclResourceType,
    resourceIds: readonly string[],
    userId: string,
  ): Promise<ReadonlyMap<string, ResourceGrantLevel>>
}

/** Provider-bound ACL response reads for resource-catalog-owned aggregates. */
export interface ResourceCatalogAclReadPort<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
> {
  readSnapshot(
    type: Type,
    resourceId: string,
    fallbackIdentity: AclRow,
  ): Promise<{
    readonly identity: AclRow
    readonly aclRevision: number
    readonly grants: ReadonlyArray<{
      readonly userId: string
      readonly level: ResourceGrantLevel
    }>
    readonly users: ReadonlyMap<string, UserPublic>
  } | null>
}

export interface ResourceCatalogAclMutationRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
}

/**
 * Data loaded inside the provider's transaction before the synchronous ACL
 * decision runs. No transaction handle or ORM row escapes infrastructure.
 */
export interface ResourceCatalogAclMutationSnapshot {
  readonly current: ResourceCatalogAclMutationRow
  readonly ownerNameIsUnique: boolean
  readonly ownerNameCollision: boolean
  readonly activeUserIds: ReadonlySet<string>
  readonly currentGrants: ReadonlyMap<string, ResourceGrantLevel>
  readonly actorGrantLevel: ResourceGrantLevel | null
}

export interface ResourceCatalogAclMutationResult {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
  readonly grantedUserIds: ReadonlySet<string>
}

export interface ResourceCatalogAclMutationDecision {
  readonly update: {
    readonly ownerUserId: string | null
    readonly visibility: ResourceVisibility
    readonly aclRevision: number
    readonly updatedAt: number
  }
  readonly grants: ReadonlyMap<string, ResourceGrantLevel>
  readonly addedBy: string
  readonly addedAt: number
  readonly result: ResourceCatalogAclMutationResult
}

export interface ResourceCatalogAclMutationChange<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
> {
  readonly type: Type
  readonly resourceId: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
  readonly grantedUserIds: ReadonlySet<string>
  readonly now: number
}

export interface ResourceCatalogAclMutationRequest<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
> {
  readonly type: Type
  readonly resourceId: string
  readonly actorUserId: string
  readonly referencedUserIds: readonly string[]
  readonly candidateOwnerUserId: string | null | undefined
}

/** Provider-private transaction + provider-neutral synchronous decision. */
export interface ResourceCatalogAclMutationPort<
  Type extends AclResourceType = ResourceCatalogOwnedAclType,
> {
  mutate(
    request: ResourceCatalogAclMutationRequest<Type>,
    decide: (snapshot: ResourceCatalogAclMutationSnapshot) => ResourceCatalogAclMutationDecision,
  ): Promise<ResourceCatalogAclMutationResult | undefined>
  isOwnerNameConstraintError(error: unknown): boolean
}

/** Internal owner/name preflight seam; it is deliberately absent from public/. */
export interface ResourceCatalogAclIdentityReadPort {
  getOwner(type: CatalogSelectorKind, id: string): Promise<string | null | undefined>
  listOwnedNames(type: CatalogSelectorKind, ownerUserId: string): Promise<readonly string[]>
}

export interface ResourceCatalogSummaryReadQuery {
  readonly search?: string
  readonly after?: Readonly<{ name: string; id: string }>
  readonly limit: number
}

/** One provider-owned classic-six page; cross-kind merge/cursor stays application-owned. */
export interface ResourceCatalogSummaryReadPort {
  listKind(
    actor: Actor,
    kind: CatalogSelectorKind,
    query: ResourceCatalogSummaryReadQuery,
  ): Promise<readonly ResourceSummary[]>
}

/** Narrow provider-neutral ACL persistence bundle selected by bootstrap. */
export interface ResourceCatalogAclPersistence {
  readonly grants: ResourceCatalogGrantReadPort
  readonly reads: ResourceCatalogAclReadPort
  readonly mutations: ResourceCatalogAclMutationPort
  readonly identities: ResourceCatalogAclIdentityReadPort
}

/**
 * Transaction-bound synchronous snapshot used only by the legacy in-tx
 * participant.  The application sees no provider transaction or query API.
 */
export interface ResourceCatalogAclSnapshotReadPort {
  getAccessRow(type: CatalogSelectorKind, resourceId: string): AclRow | null
  getGrantLevel(
    type: CatalogSelectorKind,
    resourceId: string,
    userId: string,
  ): ResourceGrantLevel | null
}
