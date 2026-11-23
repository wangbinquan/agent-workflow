import { canonicalStoredAccess } from '../domain/userAccessPolicy'
import type { ManagedUserStatus } from '../public/types'
import type { UserAccessRecord, UserPermissionGrantRecord } from './ports/userAccessRepository'
import type { Permission, Role } from '@agent-workflow/shared'

export function materializeUserAccessView(
  user: UserAccessRecord,
  grants: ReadonlyArray<UserPermissionGrantRecord | string>,
): AdminUserAccessView {
  const canonical = canonicalStoredAccess({
    role: user.role,
    storedPermissions: grants.map((grant) =>
      typeof grant === 'string' ? grant : grant.permission,
    ),
  })
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    forcePasswordChange: user.forcePasswordChange,
    history: {
      createdBy: user.createdBy,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    },
    additionalPermissions: canonical.additionalPermissions,
    accessRevision: user.accessRevision,
  }
}

// RFC-551 (RFC-294 S9): moved from `public/types` (no other module read it); the view this module's user operations
// project from.
export interface AdminUserAccessView {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly displayName: string
  readonly role: Role
  readonly status: ManagedUserStatus
  readonly forcePasswordChange: boolean
  readonly history: Readonly<{
    createdBy: string | null
    createdAt: number
    updatedAt: number
    lastLoginAt: number | null
  }>
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly accessRevision: number
}
