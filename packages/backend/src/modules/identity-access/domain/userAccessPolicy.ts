import {
  PERMISSIONS,
  additionalPermissionsForRole,
  normalizeAdditionalPermissionsForWrite,
  normalizeStoredAdditionalPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'

export interface CanonicalUserAccess {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<Permission>
}

export interface UserAccessTransition extends CanonicalUserAccess {
  readonly addedPermissions: ReadonlyArray<Permission>
  readonly removedPermissions: ReadonlyArray<Permission>
  readonly changed: boolean
}

export function canonicalStoredAccess(input: {
  readonly role: Role
  readonly storedPermissions: ReadonlyArray<unknown>
}): CanonicalUserAccess & {
  readonly diagnostics: ReturnType<typeof normalizeStoredAdditionalPermissions>['diagnostics']
} {
  const normalized = normalizeStoredAdditionalPermissions({
    role: input.role,
    additionalPermissions: input.storedPermissions,
  })
  return {
    role: input.role,
    additionalPermissions: normalized.additionalPermissions,
    diagnostics: normalized.diagnostics,
  }
}

export function planExactAccessTransition(input: {
  readonly currentRole: Role
  readonly currentStoredPermissions: ReadonlyArray<unknown>
  readonly nextRole: Role
  readonly nextAdditionalPermissions: ReadonlyArray<unknown>
}): UserAccessTransition {
  const current = canonicalStoredAccess({
    role: input.currentRole,
    storedPermissions: input.currentStoredPermissions,
  })
  const next = normalizeAdditionalPermissionsForWrite({
    role: input.nextRole,
    additionalPermissions: input.nextAdditionalPermissions,
  })
  return transitionResult(current, { role: input.nextRole, additionalPermissions: next })
}

/** Legacy role PATCH: replace the preset and retain only explicit grants. */
export function planLegacyRoleTransition(input: {
  readonly currentRole: Role
  readonly currentStoredPermissions: ReadonlyArray<unknown>
  readonly nextRole: Role
}): UserAccessTransition {
  const current = canonicalStoredAccess({
    role: input.currentRole,
    storedPermissions: input.currentStoredPermissions,
  })
  return transitionResult(current, {
    role: input.nextRole,
    additionalPermissions: additionalPermissionsForRole(
      input.nextRole,
      new Set(current.additionalPermissions),
    ),
  })
}

function transitionResult(
  current: CanonicalUserAccess,
  next: CanonicalUserAccess,
): UserAccessTransition {
  const before = new Set(current.additionalPermissions)
  const after = new Set(next.additionalPermissions)
  const addedPermissions = PERMISSIONS.filter(
    (permission) => after.has(permission) && !before.has(permission),
  )
  const removedPermissions = PERMISSIONS.filter(
    (permission) => before.has(permission) && !after.has(permission),
  )
  return {
    ...next,
    addedPermissions,
    removedPermissions,
    changed:
      current.role !== next.role || addedPermissions.length > 0 || removedPermissions.length > 0,
  }
}

export type AccessInvariantFailure =
  | 'system-user-immutable'
  | 'self-access-change-forbidden'
  | 'last-access-administrator-protection'

export function accessInvariantFailure(input: {
  readonly targetUserId: string
  readonly actorUserId: string | null
  readonly currentStatus: 'active' | 'disabled' | 'invited'
  readonly nextStatus: 'active' | 'disabled' | 'invited'
  readonly accessChanged: boolean
  readonly currentCanManageUserAccess: boolean
  readonly nextCanManageUserAccess: boolean
  readonly otherActiveAccessAdministratorCount: number
  readonly systemUserId: string
}): AccessInvariantFailure | null {
  if (input.targetUserId === input.systemUserId) return 'system-user-immutable'
  if (input.actorUserId === input.targetUserId && input.accessChanged) {
    return 'self-access-change-forbidden'
  }
  const removesLastAccessAdministrator =
    input.currentCanManageUserAccess &&
    input.currentStatus === 'active' &&
    (!input.nextCanManageUserAccess || input.nextStatus !== 'active')
  if (removesLastAccessAdministrator && input.otherActiveAccessAdministratorCount === 0) {
    return 'last-access-administrator-protection'
  }
  return null
}
