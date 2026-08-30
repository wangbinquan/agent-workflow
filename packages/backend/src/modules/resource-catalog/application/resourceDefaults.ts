import type { TaskActorRole } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ValidationError } from '@/util/errors'
import { hasResourceAclBypass } from '../domain/resourceAccess'

/** Product default for every newly-created user ACL resource. */
export const DEFAULT_USER_RESOURCE_VISIBILITY = 'private' as const

export function initialPrivateResourceAcl(ownerUserId: string | null): {
  readonly ownerUserId: string | null
  readonly visibility: typeof DEFAULT_USER_RESOURCE_VISIBILITY
  readonly aclRevision: 0
} {
  return { ownerUserId, visibility: DEFAULT_USER_RESOURCE_VISIBILITY, aclRevision: 0 }
}

/** Framework-owned resources are discoverable and read-only by default. */
export function initialBuiltinResourceAcl(ownerUserId: string | null): {
  readonly ownerUserId: string | null
  readonly visibility: 'public'
  readonly aclRevision: 0
} {
  return { ownerUserId, visibility: 'public', aclRevision: 0 }
}

export function assertInitialResourceOwner(
  actor: Actor | null | undefined,
  ownerUserId: string | null,
): void {
  if (actor === null || actor === undefined || ownerUserId === actor.user.id) return
  throw new ValidationError(
    'resource-owner-mismatch',
    'resource owner must match the authenticated creator',
  )
}

export function canAuditIntentSessions(actor: Actor): boolean {
  return actor.permissions.has('intent:audit')
}

export function resolveTaskRole(
  actor: Actor,
  taskOwnerUserId: string | null,
  isMember: boolean,
): TaskActorRole | null {
  if (taskOwnerUserId !== null && taskOwnerUserId === actor.user.id) return 'owner'
  if (isMember) return 'user'
  if (!hasResourceAclBypass(actor)) return null
  return actor.permissions.has('users:write') ? 'admin' : 'manager'
}
