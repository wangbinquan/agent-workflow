import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { UserAccessError, type ManagedUserStatus } from '../public/types'

export function admissionSubjectOf(
  actor: { readonly role: Role; readonly status: ManagedUserStatus } | null,
  storedPermissions: ReadonlyArray<unknown>,
): { readonly permissions: ReadonlySet<Permission>; readonly status: ManagedUserStatus } | null {
  if (actor === null) return null
  const additionalPermissions = normalizeStoredAdditionalPermissions({
    role: actor.role,
    additionalPermissions: storedPermissions,
  }).additionalPermissions
  return {
    status: actor.status,
    permissions: resolveEffectiveAccountPermissions({ role: actor.role, additionalPermissions }),
  }
}

/** Directory reads accept trusted daemon HTTP calls for backward
 * compatibility. The stored role is only an input to the shared preset
 * resolver above. */
export function admitUserDirectoryQuery(
  actor: {
    readonly permissions: ReadonlySet<Permission>
    readonly status: ManagedUserStatus
  } | null,
  context: { readonly source: string; readonly transport: string },
): void {
  if (context.source === 'cli' && context.transport === 'cli') return
  if (
    (context.source !== 'session' && context.source !== 'daemon') ||
    context.transport !== 'http' ||
    actor === null ||
    actor.status !== 'active' ||
    !actor.permissions.has('users:read')
  ) {
    throw new UserAccessError(
      'forbidden',
      'user-directory-forbidden',
      'user directory requires users:read',
    )
  }
}

/** Profile/status administration is a write even when it does not replace
 * the role/grant snapshot, so it requires `users:write`. */
export function admitUserDirectoryAccess(
  actor: {
    readonly permissions: ReadonlySet<Permission>
    readonly status: ManagedUserStatus
  } | null,
  context: { readonly source: string; readonly transport: string },
): void {
  if (context.source === 'cli' && context.transport === 'cli') return
  if (
    (context.source !== 'session' && context.source !== 'daemon') ||
    context.transport !== 'http' ||
    actor === null ||
    actor.status !== 'active' ||
    !actor.permissions.has('users:write')
  ) {
    throw new UserAccessError(
      'forbidden',
      'user-management-forbidden',
      'user management requires users:write',
    )
  }
}

/** Role presets and explicit grants are one atomic access snapshot. Only an
 * active interactive session with `users:write` (or local break-glass CLI)
 * may replace it; PAT and daemon transports stay outside this human workflow. */
export function admitUserAccessMutation(
  actor: {
    readonly permissions: ReadonlySet<Permission>
    readonly status: ManagedUserStatus
  } | null,
  context: { readonly source: string; readonly transport: string },
): void {
  if (context.source === 'cli' && context.transport === 'cli') return
  if (
    context.source !== 'session' ||
    context.transport !== 'http' ||
    actor === null ||
    actor.status !== 'active' ||
    !actor.permissions.has('users:write')
  ) {
    throw new UserAccessError(
      'forbidden',
      'user-access-management-forbidden',
      'user access management requires an active session with users:write',
    )
  }
}

export function userAccessAuditKind(source: string): 'session' | 'cli' | 'system' {
  if (source === 'cli') return 'cli'
  if (source === 'system' || source === 'daemon') return 'system'
  return 'session'
}
