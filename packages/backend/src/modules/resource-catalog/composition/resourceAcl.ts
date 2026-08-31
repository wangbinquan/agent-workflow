import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { assertNotBuiltin } from '@/services/systemResources'
import { triggerRevalidation } from '@/ws/revalidationHook'
import {
  createResourceAclApplication,
  createResourceAclOperationApplication,
  type ResourceAclOperationLinearizer,
} from '../application/resourceAcl'
import {
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
import type {
  AclResourceType,
  ResourceAcl,
  ResourceVisibility,
  UpdateResourceAclBody,
} from '@agent-workflow/shared'
import type { AclRow } from '../domain/resourceAccess'

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

export interface ResourceAclOperationCompositionDependencies<Row extends AclRow> {
  readonly db: DbClient
  readonly type: AclResourceType
  load(id: string): Promise<Row | null>
  readonly linearizer?: ResourceAclOperationLinearizer<Row>
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
  afterUpdated?(resourceId: string): void | Promise<void>
}

/** Owner composition for the classic-six descriptor-backed ACL operations. */
export function composeResourceAclOperationApplication<Context extends Actor, Row extends AclRow>(
  input: ResourceAclOperationCompositionDependencies<Row>,
) {
  return createResourceAclOperationApplication<Context, Row>({
    type: input.type,
    load: input.load,
    canView: (authority, row) => canViewResource(input.db, authority, input.type, row),
    assertMutable: (row) => assertNotBuiltin(input.type, row),
    read: (authority, row) => getResourceAcl(input.db, authority, input.type, row),
    update: (
      authority: Context,
      row: Row,
      body: UpdateResourceAclBody,
      updatedAt?: number,
    ): Promise<ResourceAcl> =>
      updateResourceAcl(input.db, authority, input.type, row, body, {
        updatedAt,
        afterWriteInTx: input.afterWriteInTx,
        afterCommit: (db) => triggerRevalidation(db, 'resource-acl-changed'),
      }),
    linearizer: input.linearizer,
    afterUpdated: input.afterUpdated,
  })
}

const participantDependencies = { accessRows, authorization }

export interface ResourceScopeAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

export interface ResourceScopeAuthorizationBinding {
  inTransaction(tx: DbTxSync, pair: ResourceScopeAuthorityPair): ResourceScopeAuthorizationInTx
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
