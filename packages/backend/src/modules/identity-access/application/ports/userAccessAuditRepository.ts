import type { Permission, Role } from '@agent-workflow/shared'

export interface UserAccessAuditRecord {
  readonly id: string
  readonly targetUserId: string
  readonly actorUserId: string | null
  readonly actorKind: 'session' | 'cli' | 'system'
  readonly operationId: string
  readonly correlationId: string | null
  readonly beforeRole: Role
  readonly afterRole: Role
  readonly addedPermissions: ReadonlyArray<Permission>
  readonly removedPermissions: ReadonlyArray<Permission>
  readonly accessRevision: number
  readonly createdAt: number
}

export interface UserAccessAuditTransactionParticipant {
  appendAudit(record: UserAccessAuditRecord): void
}
