import type { Permission } from '@agent-workflow/shared'

export type AccessUpdateOutcome = 'success' | 'no-op' | 'conflict' | 'rejected'

export interface AccessUpdateObservation {
  readonly operationId: string
  readonly targetUserId: string
  readonly outcome: AccessUpdateOutcome
  readonly revision?: number
  readonly addedPermissions: ReadonlyArray<Permission>
  readonly removedPermissions: ReadonlyArray<Permission>
}

export interface ManagedUserCreateObservation {
  readonly operationId: string
  readonly targetUserId: string
  readonly outcome: 'success' | 'rejected'
  readonly revision?: number
  readonly addedPermissions: ReadonlyArray<Permission>
}

export interface IdentityAccessObserver {
  accessUpdate(observation: AccessUpdateObservation): void
  managedUserCreate(observation: ManagedUserCreateObservation): void
  authorityReresolution(userId: string): void
  invalidStoredGrant(observation: {
    readonly userId: string
    readonly code: string
    readonly permission: unknown
  }): void
  targetedRefreshFailure(observation: {
    readonly userId: string
    readonly revision: number
    readonly error: unknown
  }): void
}
