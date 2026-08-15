import {
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import {
  accessInvariantFailure,
  canonicalStoredAccess,
  planExactAccessTransition,
  planLegacyRoleTransition,
  type UserAccessTransition,
} from '../../domain/userAccessPolicy'
import type { IdentityAccessEventSink } from '../../public/events'
import {
  UserAccessError,
  type AdminUserAccessView,
  type ManagedUserStatus,
} from '../../public/types'
import {
  admissionSubjectOf,
  admitUserAccessMutation,
  admitUserDirectoryAccess,
  userAccessAuditKind,
} from '../accessAdmission'
import { mapPermissionValidationError } from '../errors'
import { subjectRefOf, trustedContextMetadata, type CommandContext } from '../operationContext'
import type { IdentityAccessObserver } from '../ports/identityAccessObserver'
import type { UserAccessRecord } from '../ports/userAccessRepository'
import type { UserAccessTransactionRunner } from '../ports/userAccessTransaction'
import { materializeUserAccessView } from '../view'

export interface ExactAccessSnapshot {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly expectedRevision: number
}

export interface UpdateUserAccessCommand {
  readonly targetUserId: string
  readonly displayName?: string
  readonly email?: string | null
  readonly status?: ManagedUserStatus
  readonly forcePasswordChange?: boolean
  readonly access?: ExactAccessSnapshot
  /** RFC-305 one-release compatibility seam; mutually exclusive with access. */
  readonly legacyRole?: Role
}

export interface UpdateUserAccessResult {
  readonly user: AdminUserAccessView
  readonly changed: boolean
  readonly accessChanged: boolean
  readonly becameDisabled: boolean
}

export interface UpdateUserAccessDeps {
  readonly transactions: UserAccessTransactionRunner
  readonly auditId: () => string
  readonly systemUserId: string
  readonly events: IdentityAccessEventSink
  readonly observer?: IdentityAccessObserver
}

interface TransactionResult extends UpdateUserAccessResult {
  readonly revision: number
  readonly addedPermissions: ReadonlyArray<Permission>
  readonly removedPermissions: ReadonlyArray<Permission>
}

export class UpdateUserAccess {
  constructor(private readonly deps: UpdateUserAccessDeps) {}

  async execute(
    context: CommandContext,
    command: UpdateUserAccessCommand,
  ): Promise<UpdateUserAccessResult> {
    if (command.access !== undefined && command.legacyRole !== undefined) {
      throw new UserAccessError(
        'validation',
        'user-access-ambiguous',
        'access and legacy role cannot be sent together',
      )
    }
    const contextMeta = trustedContextMetadata(context)
    let committed: TransactionResult
    try {
      committed = this.deps.transactions.run((transaction) => {
        const actorUserId = subjectRefOf(context.authority).userId
        const actor = transaction.findUser(actorUserId)
        const admissionSubject = admissionSubjectOf(
          actor,
          actor === null ? [] : transaction.listGrants(actor.id).map((grant) => grant.permission),
        )
        if (command.access !== undefined || command.legacyRole !== undefined) {
          admitUserAccessMutation(admissionSubject, contextMeta)
        } else {
          admitUserDirectoryAccess(admissionSubject, contextMeta)
        }
        const current = transaction.findUser(command.targetUserId)
        if (current === null) {
          throw new UserAccessError('not-found', 'user-not-found', 'user not found')
        }
        if (current.id === this.deps.systemUserId) {
          throw new UserAccessError(
            'validation',
            'system-user-immutable',
            'cannot modify the system user',
          )
        }
        const currentGrants = transaction.listGrants(current.id)
        if (
          command.access !== undefined &&
          command.access.expectedRevision !== current.accessRevision
        ) {
          throw new UserAccessError('conflict', 'user-access-stale', 'user access changed', {
            currentRevision: current.accessRevision,
          })
        }

        const transition = this.planTransition(current, currentGrants, command)
        const currentPermissions = resolveEffectiveAccountPermissions({
          role: current.role,
          additionalPermissions: canonicalStoredAccess({
            role: current.role,
            storedPermissions: currentGrants.map((grant) => grant.permission),
          }).additionalPermissions,
        })
        const nextPermissions = resolveEffectiveAccountPermissions({
          role: transition.role,
          additionalPermissions: transition.additionalPermissions,
        })
        const nextStatus = command.status ?? current.status
        if (
          actorUserId === current.id &&
          nextStatus === 'disabled' &&
          current.status !== 'disabled'
        ) {
          throw new UserAccessError(
            'validation',
            'self-disable-forbidden',
            'cannot disable your own account',
          )
        }
        const invariant = accessInvariantFailure({
          targetUserId: current.id,
          actorUserId: contextMeta.source === 'cli' ? null : actorUserId,
          currentStatus: current.status,
          nextStatus,
          accessChanged: transition.changed,
          currentCanManageUserAccess: currentPermissions.has('users:write'),
          nextCanManageUserAccess: nextPermissions.has('users:write'),
          otherActiveAccessAdministratorCount: transaction.countOtherActiveAccessAdministrators(
            current.id,
            this.deps.systemUserId,
          ),
          systemUserId: this.deps.systemUserId,
        })
        if (invariant !== null) {
          throw new UserAccessError('validation', invariant, invariantMessage(invariant))
        }

        const profileValues = changedProfileValues(current, command, nextStatus)
        const profileChanged = Object.keys(profileValues).length > 0
        if (!transition.changed && !profileChanged) {
          return {
            user: materializeUserAccessView(current, currentGrants),
            changed: false,
            accessChanged: false,
            becameDisabled: false,
            revision: current.accessRevision,
            addedPermissions: [],
            removedPermissions: [],
          }
        }

        const nextRevision = current.accessRevision + (transition.changed ? 1 : 0)
        const updatedAt = context.now
        const updated = transaction.updateUserConditional({
          id: current.id,
          expectedAccessRevision: current.accessRevision,
          accessChanged: transition.changed,
          values: {
            ...profileValues,
            ...(transition.changed ? { role: transition.role, accessRevision: nextRevision } : {}),
            updatedAt,
          },
        })
        if (!updated) {
          throw new UserAccessError('conflict', 'user-access-stale', 'user access changed')
        }

        if (transition.changed) {
          const next = new Set(transition.additionalPermissions)
          for (const grant of currentGrants) {
            if (!next.has(grant.permission as Permission)) {
              transaction.deleteGrantValue(current.id, grant.permission)
            }
          }
          const currentCanonical = new Set(
            canonicalStoredAccess({
              role: current.role,
              storedPermissions: currentGrants.map((grant) => grant.permission),
            }).additionalPermissions,
          )
          for (const permission of transition.additionalPermissions) {
            if (currentCanonical.has(permission)) continue
            transaction.insertGrant({
              userId: current.id,
              permission,
              grantedByUserId: contextMeta.source === 'cli' ? null : actorUserId,
              grantedAt: context.now,
            })
          }
          transaction.appendAudit({
            id: this.deps.auditId(),
            targetUserId: current.id,
            actorUserId: contextMeta.source === 'cli' ? null : actorUserId,
            actorKind: userAccessAuditKind(contextMeta.source),
            operationId: context.operationId,
            correlationId: context.correlationId,
            beforeRole: current.role,
            afterRole: transition.role,
            addedPermissions: transition.addedPermissions,
            removedPermissions: transition.removedPermissions,
            accessRevision: nextRevision,
            createdAt: context.now,
          })
        }
        const becameDisabled = current.status !== 'disabled' && nextStatus === 'disabled'
        if (becameDisabled) transaction.transitionDisabledOwner(current.id, context.now)
        const nextRecord: UserAccessRecord = {
          ...current,
          ...profileValues,
          role: transition.role,
          updatedAt,
          accessRevision: nextRevision,
        }
        return {
          user: materializeUserAccessView(nextRecord, transition.additionalPermissions),
          changed: true,
          accessChanged: transition.changed,
          becameDisabled,
          revision: nextRevision,
          addedPermissions: transition.addedPermissions,
          removedPermissions: transition.removedPermissions,
        }
      })
    } catch (error) {
      if (command.access !== undefined || command.legacyRole !== undefined) {
        this.deps.observer?.accessUpdate({
          operationId: context.operationId,
          targetUserId: command.targetUserId,
          outcome:
            error instanceof UserAccessError && error.kind === 'conflict' ? 'conflict' : 'rejected',
          addedPermissions: [],
          removedPermissions: [],
        })
      }
      return mapPermissionValidationError(error)
    }

    if (committed.accessChanged) {
      try {
        this.deps.events.authorityRevisionChanged({
          type: 'authority.revision-changed',
          subjectRef: { userId: command.targetUserId },
          revision: committed.revision,
        })
      } catch (error) {
        this.deps.observer?.targetedRefreshFailure({
          userId: command.targetUserId,
          revision: committed.revision,
          error,
        })
      }
    }
    if (command.access !== undefined || command.legacyRole !== undefined) {
      this.deps.observer?.accessUpdate({
        operationId: context.operationId,
        targetUserId: command.targetUserId,
        outcome: committed.accessChanged ? 'success' : 'no-op',
        revision: committed.revision,
        addedPermissions: committed.addedPermissions,
        removedPermissions: committed.removedPermissions,
      })
    }
    return {
      user: committed.user,
      changed: committed.changed,
      accessChanged: committed.accessChanged,
      becameDisabled: committed.becameDisabled,
    }
  }

  private planTransition(
    current: UserAccessRecord,
    grants: ReadonlyArray<{ readonly permission: string }>,
    command: UpdateUserAccessCommand,
  ): UserAccessTransition {
    if (command.access !== undefined) {
      return planExactAccessTransition({
        currentRole: current.role,
        currentStoredPermissions: grants.map((grant) => grant.permission),
        nextRole: command.access.role,
        nextAdditionalPermissions: command.access.additionalPermissions,
      })
    }
    if (command.legacyRole !== undefined) {
      return planLegacyRoleTransition({
        currentRole: current.role,
        currentStoredPermissions: grants.map((grant) => grant.permission),
        nextRole: command.legacyRole,
      })
    }
    const canonical = canonicalStoredAccess({
      role: current.role,
      storedPermissions: grants.map((grant) => grant.permission),
    })
    return {
      ...canonical,
      addedPermissions: [],
      removedPermissions: [],
      changed: false,
    }
  }
}

function invariantMessage(code: string): string {
  switch (code) {
    case 'system-user-immutable':
      return 'cannot modify __system__ user'
    case 'self-access-change-forbidden':
      return 'cannot change your own account access'
    case 'last-access-administrator-protection':
      return 'cannot remove the last active users:write account'
    default:
      return code
  }
}

function changedProfileValues(
  current: UserAccessRecord,
  command: UpdateUserAccessCommand,
  nextStatus: ManagedUserStatus,
): Partial<Pick<UserAccessRecord, 'displayName' | 'email' | 'status' | 'forcePasswordChange'>> {
  const values: {
    displayName?: string
    email?: string | null
    status?: ManagedUserStatus
    forcePasswordChange?: boolean
  } = {}
  if (command.displayName !== undefined && command.displayName !== current.displayName) {
    values.displayName = command.displayName
  }
  if (command.email !== undefined && command.email !== current.email) values.email = command.email
  if (nextStatus !== current.status) values.status = nextStatus
  if (
    command.forcePasswordChange !== undefined &&
    command.forcePasswordChange !== current.forcePasswordChange
  ) {
    values.forcePasswordChange = command.forcePasswordChange
  }
  return values
}
