import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import { createResourceAclApplication } from '../application/resourceAcl'
import {
  createResourceAuthorizationInTx as createResourceAuthorizationParticipantInTx,
  createResourceScopeAuthorizationInTx as createResourceScopeAuthorizationParticipantInTx,
  type ResourceCurrentAuthorityResolver,
} from '../application/participants/resourceAuthorization'
import type { ResourceRequestContext, ResourceScopeAuthorizationInTx } from '../public/participants'
import type {
  ResourceAccessRowReadPort,
  ResourceAclMutationPort,
  ResourceAclReadPort,
  ResourceGrantReadPort,
} from '../application/ports/resourceAclPersistence'
import { createResourceAuthorizationApplication } from '../application/resourceAuthorization'
import { getAclResourceAccessRowInTx } from '../infrastructure/sqliteAclReadRepository'
import {
  getSqliteResourceAclRevision,
  isSqliteOwnerNameConstraintError,
  loadAclUsers,
  withSqliteResourceAclMutation,
} from '../infrastructure/sqliteResourceAclRepository'
import {
  listGrantedResourceIds,
  listResourceGrants,
  listResourceGrantsInTx,
  loadGrantLevel,
  loadGrantLevelInTx,
  loadGrantLevelsForUser,
} from '../infrastructure/sqliteResourceGrantRepository'

const grantReads: ResourceGrantReadPort = {
  listGrantedResourceIds: (db, actor, type) => listGrantedResourceIds(db, actor, type),
  loadGrantLevel: (db, type, resourceId, userId) => loadGrantLevel(db, type, resourceId, userId),
  loadGrantLevelInTx: (tx, type, resourceId, userId) =>
    loadGrantLevelInTx(tx, type, resourceId, userId),
  loadGrantLevelsForUser: (db, type, resourceIds, userId) =>
    loadGrantLevelsForUser(db, type, resourceIds, userId),
}

const aclReads: ResourceAclReadPort = {
  getRevision: (db, type, resourceId, identityPersistence) =>
    getSqliteResourceAclRevision(db, type, resourceId, identityPersistence),
  listGrants: (db, type, resourceId) => listResourceGrants(db, type, resourceId),
  loadUsers: (db, userIds) => loadAclUsers(db, userIds),
}

const aclMutations: ResourceAclMutationPort = {
  withMutation: (db, type, resourceId, identityPersistence, run) =>
    withSqliteResourceAclMutation(db, type, resourceId, identityPersistence, run),
  listGrantsInTx: (tx, type, resourceId) => listResourceGrantsInTx(tx, type, resourceId),
  isOwnerNameConstraintError: isSqliteOwnerNameConstraintError,
}

const accessRows: ResourceAccessRowReadPort = {
  getInTx: (tx, type, resourceId) => getAclResourceAccessRowInTx(tx, type, resourceId),
}

const authorization = createResourceAuthorizationApplication(grantReads)
const acl = createResourceAclApplication({ authorization, mutation: aclMutations, read: aclReads })

export const {
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
} = authorization

export const { getResourceAcl, updateResourceAcl } = acl

const participantDependencies = { accessRows, authorization }

export interface ResourceScopeAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

export interface ResourceScopeAuthorizationBinding {
  inTransaction(tx: DbTxSync, pair: ResourceScopeAuthorityPair): ResourceScopeAuthorizationInTx
}

export function createResourceAuthorizationInTx(
  tx: DbTxSync,
  authorityResolver: ResourceCurrentAuthorityResolver,
) {
  return createResourceAuthorizationParticipantInTx(tx, authorityResolver, participantDependencies)
}

export function createResourceScopeAuthorizationInTx(
  tx: DbTxSync,
  authorityResolver: ResourceCurrentAuthorityResolver,
) {
  return createResourceScopeAuthorizationParticipantInTx(
    tx,
    authorityResolver,
    participantDependencies,
  )
}

/**
 * Bootstrap-owned adapter for the memory consumer.  The participant accepts
 * only the exact opaque handle paired with the current actor; it never falls
 * back to a structurally compatible Actor bag.
 */
export function composeResourceScopeAuthorizationBinding(): ResourceScopeAuthorizationBinding {
  return Object.freeze({
    inTransaction(tx: DbTxSync, pair: ResourceScopeAuthorityPair) {
      return createResourceScopeAuthorizationInTx(tx, {
        resolve(authority) {
          if (authority !== pair.authority) {
            throw new Error('foreign-resource-scope-authority')
          }
          return pair.actor
        },
      })
    },
  })
}
