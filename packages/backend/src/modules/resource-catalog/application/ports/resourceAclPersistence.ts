import type { AclResourceType, ResourceVisibility } from '@agent-workflow/shared'

/** ACL identity tables whose aggregate writer remains outside resource-catalog. */
export type ForeignResourceAclType = Extract<
  AclResourceType,
  'development_adapter' | 'employee_definition' | 'employee_tool' | 'employee_job_template'
>

export interface ResourceAclIdentityMutationRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
}

export interface ResourceAclIdentityMutation {
  readonly current: ResourceAclIdentityMutationRow
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): boolean
  update(input: {
    readonly ownerUserId: string | null
    readonly visibility: ResourceVisibility
    readonly aclRevision: number
    readonly updatedAt: number
  }): void
}

/**
 * Consumer-owned identity persistence seam for ACL resources whose aggregate
 * table belongs to another bounded context. The provider owns the synchronous
 * transaction and never exposes its SQLite handle or table descriptor.
 */
export interface ResourceAclIdentityPersistence {
  readonly type: ForeignResourceAclType
  getRevision(resourceId: string): number
  withMutation<T>(
    resourceId: string,
    run: (mutation: ResourceAclIdentityMutation) => T,
  ): T | undefined
}
