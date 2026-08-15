import { canonicalStoredAccess } from '../domain/userAccessPolicy'
import type { AdminUserAccessView } from '../public/types'
import type { UserAccessRecord, UserPermissionGrantRecord } from './ports/userAccessRepository'

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
