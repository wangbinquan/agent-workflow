import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import { ForbiddenError, NotFoundError } from '@/util/errors'
import { canEditAccess, canGovernAccess, canViewAccess } from '../../domain/resourceAccess'
import type {
  ResourceRequestContext,
  ResourceScopeAuthorizationInTx,
} from '../../public/participants'
import type {
  ResourceAclTarget,
  ResourceMemoryScopeRef,
  ResourceScopeAccess,
} from '../../public/types'
import type { ResourceAccessRowReadPort } from '../ports/resourceAclPersistence'
import type { ResourceAuthorizationApplication } from '../resourceAuthorization'

export interface ResourceCurrentAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

export interface ResourceAuthorizationParticipantDependencies {
  readonly accessRows: ResourceAccessRowReadPort
  readonly authorization: Pick<ResourceAuthorizationApplication, 'resolveResourceAccessForInTx'>
}

interface ResourceAuthorizationInTx {
  accessOf(authority: ResourceRequestContext, target: ResourceAclTarget): ResourceScopeAccess
  assertView(authority: ResourceRequestContext, target: ResourceAclTarget): void
  assertEdit(authority: ResourceRequestContext, target: ResourceAclTarget): void
  assertGovern(authority: ResourceRequestContext, target: ResourceAclTarget): void
}

function createResourceAuthorizationInTx(
  tx: DbTxSync,
  authorityResolver: ResourceCurrentAuthorityResolver,
  dependencies: ResourceAuthorizationParticipantDependencies,
): ResourceAuthorizationInTx {
  const accessOf = (authority: ResourceRequestContext, target: ResourceAclTarget) =>
    dependencies.authorization.resolveResourceAccessForInTx(
      tx,
      authorityResolver.resolve(authority),
      target.ref.kind,
      {
        id: target.ref.id,
        ownerUserId: target.ownerUserId,
        visibility: target.visibility,
      },
    )

  const participant = Object.freeze({
    accessOf,
    assertView(authority: ResourceRequestContext, target: ResourceAclTarget) {
      if (canViewAccess(accessOf(authority, target))) return
      throw new NotFoundError('not-found', `${target.ref.kind} not found`)
    },
    assertEdit(authority: ResourceRequestContext, target: ResourceAclTarget) {
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
    assertGovern(authority: ResourceRequestContext, target: ResourceAclTarget) {
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
  })
  return participant satisfies ResourceAuthorizationInTx
}

export function createResourceScopeAuthorizationInTx(
  tx: DbTxSync,
  authorityResolver: ResourceCurrentAuthorityResolver,
  dependencies: ResourceAuthorizationParticipantDependencies,
): ResourceScopeAuthorizationInTx {
  const authorization = createResourceAuthorizationInTx(tx, authorityResolver, dependencies)
  const participant = Object.freeze({
    accessOf(authority: ResourceRequestContext, scope: ResourceMemoryScopeRef) {
      const row = dependencies.accessRows.getInTx(tx, scope.kind, scope.id)
      if (row === null) return 'none'
      return authorization.accessOf(authority, {
        ref: { kind: scope.kind, id: scope.id },
        ownerUserId: row.ownerUserId ?? null,
        visibility: row.visibility ?? 'public',
      })
    },
  }) as unknown as ResourceScopeAuthorizationInTx
  return participant
}
