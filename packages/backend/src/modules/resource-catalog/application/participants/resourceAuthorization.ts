import type { ResourceVisibility } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ForbiddenError, NotFoundError } from '@/util/errors'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
} from '../../domain/resourceAccess'
import type {
  ResourceRequestContext,
  ResourceScopeAuthorizationInTx,
} from '../../public/participants'
import type { ResourceMemoryScopeRef, ResourceScopeAccess } from '../../public/types'
import type { ResourceCatalogAclSnapshotReadPort } from '../ports/providerResourceCatalogPersistence'

export interface ResourceCurrentAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

interface ResourceAclTarget {
  readonly ref: ResourceMemoryScopeRef
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
}

interface ResourceAccessEvaluator {
  accessOf(authority: ResourceRequestContext, target: ResourceAclTarget): ResourceScopeAccess
  assertView(authority: ResourceRequestContext, target: ResourceAclTarget): void
  assertEdit(authority: ResourceRequestContext, target: ResourceAclTarget): void
  assertGovern(authority: ResourceRequestContext, target: ResourceAclTarget): void
}

function resourceAuthorizationForSnapshot(
  authorityResolver: ResourceCurrentAuthorityResolver,
  snapshots: ResourceCatalogAclSnapshotReadPort,
): ResourceAccessEvaluator {
  const accessOf = (authority: ResourceRequestContext, target: ResourceAclTarget) => {
    const actor = authorityResolver.resolve(authority)
    const audience = resourceAclAudienceAuthority(actor)
    const grant =
      audience.bypass || !audience.private
        ? null
        : snapshots.getGrantLevel(target.ref.kind, target.ref.id, actor.user.id)
    return resolveAccessFrom(audience, actor.user.id, target, grant)
  }

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
  return participant satisfies ResourceAccessEvaluator
}

const trustedResourceScopeAuthorizations = new WeakSet<ResourceScopeAuthorizationInTx>()

export function createResourceScopeAuthorization(
  authorityResolver: ResourceCurrentAuthorityResolver,
  snapshots: ResourceCatalogAclSnapshotReadPort,
): ResourceScopeAuthorizationInTx {
  const authorization = resourceAuthorizationForSnapshot(authorityResolver, snapshots)
  const participant = Object.freeze({
    accessOf(authority: ResourceRequestContext, scope: ResourceMemoryScopeRef) {
      const row = snapshots.getAccessRow(scope.kind, scope.id)
      if (row === null) return 'none'
      return authorization.accessOf(authority, {
        ref: { kind: scope.kind, id: scope.id },
        ownerUserId: row.ownerUserId ?? null,
        visibility: row.visibility ?? 'public',
      })
    },
  }) as unknown as ResourceScopeAuthorizationInTx
  trustedResourceScopeAuthorizations.add(participant)
  return participant
}
