// RFC-345 T2 compatibility facade. Policy ownership lives in
// modules/resource-catalog; legacy callers keep this stable import until their
// consumer cohort moves to the module public contract.

export { assertNameUnchangedForEditor } from '@/modules/resource-catalog/public/operations'
export {
  canEditAccess,
  canEditRow,
  canGovernAccess,
  canViewAccess,
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  isResourceNameSubmissionAllowed,
  resolveAccessFrom,
  resolveResourceAccess,
  resourceAclAudienceAuthority,
  type AclRow,
  type ResourceAclActorProjection,
  type ResourceAclAudienceAuthority,
} from '@/modules/resource-catalog/public/operations'
