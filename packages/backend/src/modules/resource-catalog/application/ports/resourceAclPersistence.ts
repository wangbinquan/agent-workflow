import type {
  AclResourceType,
  ResourceGrantLevel,
  ResourceVisibility,
  UserPublic,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { DbTxSync, NotPromise } from '@/db/txSync'
import type { AclRow, ResourceAclActorProjection } from '../../domain/resourceAccess'

/** ACL grant reads needed by application authorization policy. */
export interface ResourceGrantReadPort {
  listGrantedResourceIds(
    db: DbClient,
    actor: ResourceAclActorProjection,
    type: AclResourceType,
  ): Promise<Set<string>>
  loadGrantLevel(
    db: DbClient,
    type: AclResourceType,
    resourceId: string,
    userId: string,
  ): Promise<ResourceGrantLevel | null>
  loadGrantLevelInTx(
    tx: DbTxSync,
    type: AclResourceType,
    resourceId: string,
    userId: string,
  ): ResourceGrantLevel | null
  loadGrantLevelsForUser(
    db: DbClient,
    type: AclResourceType,
    resourceIds: readonly string[],
    userId: string,
  ): Promise<Map<string, ResourceGrantLevel>>
}

/** Read model used to render one ACL response. */
export interface ResourceAclReadPort {
  getRevision(db: DbClient, type: AclResourceType, resourceId: string): Promise<number>
  listGrants(
    db: DbClient,
    type: AclResourceType,
    resourceId: string,
  ): Promise<Array<{ readonly userId: string; readonly level: ResourceGrantLevel }>>
  loadUsers(db: DbClient, userIds: readonly string[]): Promise<ReadonlyMap<string, UserPublic>>
}

export interface ResourceAclMutationRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
}

export interface ResourceAclMutationContext {
  readonly tx: DbTxSync
  readonly current: ResourceAclMutationRow
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): boolean
  activeUserIds(userIds: readonly string[]): ReadonlySet<string>
  updateAclRow(input: {
    readonly ownerUserId: string | null
    readonly visibility: ResourceVisibility
    readonly aclRevision: number
    readonly updatedAt: number
  }): void
  replaceGrants(
    grants: ReadonlyMap<string, ResourceGrantLevel>,
    addedBy: string,
    addedAt: number,
  ): void
}

/** Transaction boundary used by the ACL update command. */
export interface ResourceAclMutationPort {
  withMutation<T>(
    db: DbClient,
    type: AclResourceType,
    resourceId: string,
    run: (context: ResourceAclMutationContext) => NotPromise<T>,
  ): T | undefined
  listGrantsInTx(
    tx: DbTxSync,
    type: AclResourceType,
    resourceId: string,
  ): Map<string, ResourceGrantLevel>
  isOwnerNameConstraintError(error: unknown): boolean
}

/** Narrow lookup needed by the resource-scope participant. */
export interface ResourceAccessRowReadPort {
  getInTx(tx: DbTxSync, type: AclResourceType, resourceId: string): AclRow | null
}
