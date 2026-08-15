import type { Permission, Role } from '@agent-workflow/shared'
import type { ManagedUserStatus } from '../../public/types'

export interface UserAccessRecord {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly displayName: string
  readonly passwordHash: string | null
  readonly role: Role
  readonly status: ManagedUserStatus
  readonly forcePasswordChange: boolean
  readonly createdBy: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastLoginAt: number | null
  readonly schemaVersion: number
  readonly accessRevision: number
}

export interface UserPermissionGrantRecord {
  readonly userId: string
  readonly permission: string
  readonly grantedByUserId: string | null
  readonly grantedAt: number
}

export type InsertManagedUserRecord = UserAccessRecord

export interface ConditionalUserUpdate {
  readonly id: string
  readonly expectedAccessRevision: number
  readonly accessChanged: boolean
  readonly values: Partial<
    Pick<
      UserAccessRecord,
      | 'displayName'
      | 'email'
      | 'role'
      | 'status'
      | 'forcePasswordChange'
      | 'updatedAt'
      | 'accessRevision'
    >
  >
}

export interface UserAccessReadRepository {
  findUser(id: string): Promise<UserAccessRecord | null>
  findUserByUsername(username: string): Promise<UserAccessRecord | null>
  listUsers(): Promise<ReadonlyArray<UserAccessRecord>>
  listGrants(userIds: ReadonlyArray<string>): Promise<ReadonlyArray<UserPermissionGrantRecord>>
}

export interface UserAccessTransactionParticipant {
  findUser(id: string): UserAccessRecord | null
  findUserByUsername(username: string): UserAccessRecord | null
  listGrants(userId: string): ReadonlyArray<UserPermissionGrantRecord>
  countOtherActiveAccessAdministrators(excludeId: string, systemUserId: string): number
  insertUser(record: InsertManagedUserRecord): void
  updateUserConditional(update: ConditionalUserUpdate): boolean
  deleteGrantValue(userId: string, permission: string): void
  deleteGrant(userId: string, permission: Permission): void
  insertGrant(record: {
    readonly userId: string
    readonly permission: Permission
    readonly grantedByUserId: string | null
    readonly grantedAt: number
  }): void
  transitionDisabledOwner(userId: string, now: number): void
}
