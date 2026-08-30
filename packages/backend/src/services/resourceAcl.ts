// RFC-345 T2 compatibility facade.
//
// Resource ACL policy, application use cases and SQLite repositories are now
// owned by modules/resource-catalog. Existing callers keep this import path
// while their named consumer/aggregate cohorts move; this file contains only
// re-exports and the legacy WebSocket composition callback.

import type {
  AclResourceType,
  ResourceAcl,
  ResourceVisibility,
  UpdateResourceAclBody,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { AclRow } from '@/modules/resource-catalog/domain/resourceAccess'
import { updateResourceAcl as updateResourceAclComposition } from '@/modules/resource-catalog/composition/resourceAcl'
import { triggerRevalidation } from '@/ws/revalidationHook'

export { assertNameUnchangedForEditor } from '@/modules/resource-catalog/application/resourceAccess'
export {
  DEFAULT_USER_RESOURCE_VISIBILITY,
  assertInitialResourceOwner,
  canAuditIntentSessions,
  initialBuiltinResourceAcl,
  initialPrivateResourceAcl,
  resolveTaskRole,
} from '@/modules/resource-catalog/application/resourceDefaults'
export {
  canEditResource,
  canEditResourceInTx,
  canGovernResource,
  canViewResource,
  canViewResourceInTx,
  discloseRefs,
  filterVisibleRows,
  projectVisibleRowsWithAccess,
  requireResourceEdit,
  requireResourceGovern,
  requireResourceView,
  resolveResourceAccessFor,
  resolveResourceAccessForInTx,
} from '@/modules/resource-catalog/composition/resourceAcl'
export { getResourceAcl } from '@/modules/resource-catalog/composition/resourceAcl'
export {
  canEditAccess,
  canEditRow,
  canGovernAccess,
  canViewAccess,
  discloseRefsSync,
  discloseScheduleRefs,
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  isVisibleRow,
  isVisibleToAudienceSnapshot,
  resolveAccessFrom,
  resolveResourceAccess,
  resourceAclAudienceAuthority,
  type AclRow,
  type DisclosedRefs,
  type ResourceAclActorProjection,
  type ResourceAclAudienceAuthority,
} from '@/modules/resource-catalog/domain/resourceAccess'
export {
  findOwnedAclResourceIdsByName,
  getAclResourceAccessRow,
  getAclResourceAccessRowInTx,
  getAclResourceIdentityRowInTx,
  getAclResourceOwner,
  getAclResourceOwnerInTx,
  listAclResourceIdentityRowsByIds,
  listAclResourceIdentityRowsByIdsInTx,
  listAclResourceIdentityRowsByNames,
  listAclResourceIdentityRowsByNamesInTx,
  listOwnedAclResourceNames,
  loadAclResourceNamesByIds,
  type AclResourceIdentitySnapshot,
} from '@/modules/resource-catalog/infrastructure/sqliteAclReadRepository'
export {
  grantsOfResourceWhere,
  grantsOfUserWhere,
  listGrantedResourceIds,
  listGrantedResourceIdsInTx,
  listResourceGrantUserIds,
  listResourceGrantUserIdsInTx,
  listResourceGrants,
  listResourceGrantsInTx,
  listWritableGrantedResourceIds,
  loadGrantLevel,
  loadGrantLevelInTx,
  loadGrantLevelsForUser,
  visibleRowsCondition,
  type AclColumnRef,
} from '@/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'

/**
 * Legacy facade wrapper. Resource persistence is bound by module composition;
 * the old service path supplies only the existing post-commit WebSocket hook.
 */
export function updateResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  body: UpdateResourceAclBody,
  options: {
    readonly updatedAt?: number
    readonly afterWriteInTx?: (
      tx: DbTxSync,
      change: {
        readonly resourceId: string
        readonly ownerUserId: string | null
        readonly visibility: ResourceVisibility
        readonly grantedUserIds: ReadonlySet<string>
        readonly now: number
      },
    ) => void
  } = {},
): Promise<ResourceAcl> {
  return updateResourceAclComposition(db, actor, type, row, body, {
    ...options,
    afterCommit: (client) => triggerRevalidation(client, 'resource-acl-changed'),
  })
}
