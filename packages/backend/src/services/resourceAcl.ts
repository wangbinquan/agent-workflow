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
import {
  getResourceAcl as getResourceAclComposition,
  updateResourceAcl as updateResourceAclComposition,
  type AclRow,
  type ResourceAclIdentityPersistence,
} from '@/modules/resource-catalog/public/operations'
import { triggerRevalidation } from '@/ws/revalidationHook'

export { assertNameUnchangedForEditor } from '@/modules/resource-catalog/public/operations'
export {
  DEFAULT_USER_RESOURCE_VISIBILITY,
  assertInitialResourceOwner,
  canAuditIntentSessions,
  initialBuiltinResourceAcl,
  initialPrivateResourceAcl,
  resolveTaskRole,
} from '@/modules/resource-catalog/public/operations'
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
} from '@/modules/resource-catalog/public/operations'
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
} from '@/modules/resource-catalog/public/operations'
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
} from '@/modules/resource-catalog/public/operations'
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
} from '@/modules/resource-catalog/public/operations'

export type { ResourceAclIdentityPersistence } from '@/modules/resource-catalog/public/operations'

export function getResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  identityPersistence?: ResourceAclIdentityPersistence,
): Promise<ResourceAcl> {
  return getResourceAclComposition(db, actor, type, row, identityPersistence)
}

/**
 * Legacy facade wrapper. Resource persistence is bound by module composition;
 * the old service path supplies only the existing post-commit WebSocket hook.
 */
export async function updateResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  body: UpdateResourceAclBody,
  options: {
    readonly identityPersistence?: ResourceAclIdentityPersistence
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
