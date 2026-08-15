import type { Permission, Role } from '@agent-workflow/shared'

export type ManagedUserStatus = 'active' | 'disabled' | 'invited'

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

/** Credential/background adapters consume current account facts through this
 * public DTO; repository rows and full HTTP Actors never cross the module. */
export interface ResolvedAuthoritySubject {
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
  readonly status: ManagedUserStatus
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly accessRevision: number
}

export type UserAccessErrorKind = 'forbidden' | 'validation' | 'conflict' | 'not-found'

export class UserAccessError extends Error {
  constructor(
    readonly kind: UserAccessErrorKind,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'UserAccessError'
  }
}
