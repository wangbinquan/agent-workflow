// RFC-345 T9 — exact compatibility facade for consumers owned by successor
// waves. Policy and provider mechanics live under modules/resource-catalog;
// this file contains no database, ORM or transaction implementation.

import { updateResourceAcl as updateResourceAclComposition } from '@/modules/resource-catalog/composition/resourceAcl'
import { triggerRevalidation } from '@/ws/revalidationHook'

export { assertNameUnchangedForEditor } from '@/modules/resource-catalog/application/resourceAccess'
export {
  assertInitialResourceOwner,
  initialBuiltinResourceAcl,
  initialPrivateResourceAcl,
  resolveTaskRole,
} from '@/modules/resource-catalog/application/resourceDefaults'
export { canAuditIntentSessions } from '@/modules/intent/public/operations'
export {
  canEditResource,
  canViewResource,
  canViewResourceInTx,
  discloseRefs,
  filterVisibleRows,
  getResourceAcl,
  projectVisibleRowsWithAccess,
  requireResourceEdit,
  requireResourceGovern,
  resolveResourceAccessFor,
  resolveResourceAccessForInTx,
} from '@/modules/resource-catalog/composition/resourceAcl'
export {
  canEditAccess,
  canEditRow,
  canGovernAccess,
  canViewAccess,
  discloseRefsSync,
  discloseScheduleRefs,
  hasResourceAclBypass,
  isVisibleRow,
  isVisibleToAudienceSnapshot,
  resourceAclAudienceAuthority,
  type AclRow,
} from '@/modules/resource-catalog/domain/resourceAccess'
export {
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
} from '@/modules/resource-catalog/infrastructure/sqliteAclReadRepository'
export {
  grantsOfResourceWhere,
  listGrantedResourceIds,
  listGrantedResourceIdsInTx,
  listResourceGrantUserIdsInTx,
  listResourceGrants,
  listWritableGrantedResourceIds,
  loadGrantLevel,
  visibleRowsCondition,
  type AclColumnRef,
} from '@/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'
export type { ResourceAclIdentityPersistence } from '@/modules/resource-catalog/application/ports/resourceAclPersistence'

/** Preserve the legacy WebSocket post-commit notification without owning DB logic. */
export function updateResourceAcl(
  ...args: Parameters<typeof updateResourceAclComposition>
): ReturnType<typeof updateResourceAclComposition> {
  const [db, actor, type, row, body, options = {}] = args
  return updateResourceAclComposition(db, actor, type, row, body, {
    ...options,
    afterCommit: () => triggerRevalidation('resource-acl-changed'),
  })
}
