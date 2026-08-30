import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import { ForbiddenError, NotFoundError } from '@/util/errors'
import { canEditAccess, canGovernAccess, canViewAccess } from '../../domain/resourceAccess'
import { getAclResourceAccessRowInTx } from '../../infrastructure/sqliteAclReadRepository'
import type {
  ResourceAuthorizationInTx,
  ResourceCurrentAuthorityInTx,
  ResourceScopeAuthorizationInTx,
} from '../../public/participants'
import type { ResourceAclTarget, ResourceMemoryScopeRef } from '../../public/types'
import { resolveResourceAccessForInTx } from '../resourceAuthorization'

export interface ResourceCurrentAuthorityResolver {
  resolve(authority: ResourceCurrentAuthorityInTx): Actor
}

export function createResourceAuthorizationInTx(
  tx: DbTxSync,
  authorityResolver: ResourceCurrentAuthorityResolver,
): ResourceAuthorizationInTx {
  const accessOf = (authority: ResourceCurrentAuthorityInTx, target: ResourceAclTarget) =>
    resolveResourceAccessForInTx(tx, authorityResolver.resolve(authority), target.ref.kind, {
      id: target.ref.id,
      ownerUserId: target.ownerUserId,
      visibility: target.visibility,
    })

  return {
    accessOf,
    assertView(authority, target) {
      if (canViewAccess(accessOf(authority, target))) return
      throw new NotFoundError('not-found', `${target.ref.kind} not found`)
    },
    assertEdit(authority, target) {
      const access = accessOf(authority, target)
      if (!canViewAccess(access)) {
        throw new NotFoundError('not-found', `${target.ref.kind} not found`)
      }
      if (canEditAccess(access)) return
      throw new ForbiddenError(
        'resource-read-only',
        `you have read-only access to this ${target.ref.kind}; ask its owner for an edit grant or make your own copy`,
      )
    },
    assertGovern(authority, target) {
      const access = accessOf(authority, target)
      if (!canViewAccess(access)) {
        throw new NotFoundError('not-found', `${target.ref.kind} not found`)
      }
      if (canGovernAccess(access)) return
      throw new ForbiddenError(
        'resource-govern-owner-only',
        `deleting, renaming, transferring or re-granting a ${target.ref.kind} is reserved for its owner`,
      )
    },
  }
}

export function createResourceScopeAuthorizationInTx(
  tx: DbTxSync,
  authorityResolver: ResourceCurrentAuthorityResolver,
): ResourceScopeAuthorizationInTx {
  const authorization = createResourceAuthorizationInTx(tx, authorityResolver)
  return {
    accessOf(authority, scope: ResourceMemoryScopeRef) {
      const row = getAclResourceAccessRowInTx(tx, scope.kind, scope.id)
      if (row === null) return 'none'
      return authorization.accessOf(authority, {
        ref: { kind: scope.kind, id: scope.id },
        ownerUserId: row.ownerUserId ?? null,
        visibility: row.visibility ?? 'public',
      })
    },
  }
}
