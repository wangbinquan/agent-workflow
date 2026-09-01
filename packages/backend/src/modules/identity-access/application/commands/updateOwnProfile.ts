import type { UserPrivateProfile } from '@agent-workflow/shared'
import { UserAccessError } from '../../public/types'
import { subjectRefOf, trustedContextMetadata, type CommandContext } from '../operationContext'
import type { UserAccessTransactionRunner } from '../ports/userAccessTransaction'

export interface UpdateOwnProfileCommand {
  readonly displayName: string
  readonly gitName: string
  readonly email: string
}

/** RFC-320 — self-only profile mutation. No access/status/password fields can
 * enter this command, so account:self can never widen into users:write. */
export class UpdateOwnProfile {
  constructor(
    private readonly deps: {
      readonly transactions: UserAccessTransactionRunner
      readonly systemUserId: string
      readonly auditId: () => string
    },
  ) {}

  async execute(
    context: CommandContext,
    command: UpdateOwnProfileCommand,
  ): Promise<UserPrivateProfile> {
    const userId = subjectRefOf(context.authority).userId
    return await this.deps.transactions.run(
      {
        operation: 'update-own-profile',
        userIds: [userId],
        emails: [command.email],
      },
      (transaction) => {
        const metadata = trustedContextMetadata(context)
        if (metadata.source !== 'session' || metadata.transport !== 'http') {
          throw new UserAccessError(
            'forbidden',
            'profile-update-forbidden',
            'profile update requires an interactive session',
          )
        }
        const current = transaction.findUser(userId)
        if (current === null) {
          throw new UserAccessError('not-found', 'user-not-found', 'user not found')
        }
        if (current.id === this.deps.systemUserId || current.status !== 'active') {
          throw new UserAccessError(
            'forbidden',
            'profile-update-forbidden',
            'profile cannot be updated',
          )
        }
        const conflict = transaction.findUserByEmail(command.email)
        if (conflict !== null && conflict.id !== current.id) {
          throw new UserAccessError(
            'conflict',
            'profile-email-conflict',
            'email already belongs to another user',
          )
        }
        const changed =
          current.displayName !== command.displayName ||
          current.gitName !== command.gitName ||
          current.email !== command.email
        if (changed) {
          const updated = transaction.updateUserConditional({
            id: current.id,
            expectedAccessRevision: current.accessRevision,
            accessChanged: false,
            values: {
              displayName: command.displayName,
              gitName: command.gitName,
              email: command.email,
              updatedAt: context.now,
            },
          })
          if (!updated) {
            throw new UserAccessError('conflict', 'profile-update-conflict', 'profile changed')
          }
          transaction.appendAudit({
            id: this.deps.auditId(),
            targetUserId: current.id,
            actorUserId: userId,
            actorKind: 'session',
            operationId: context.operationId,
            correlationId: context.correlationId,
            beforeRole: current.role,
            afterRole: current.role,
            addedPermissions: [],
            removedPermissions: [],
            accessRevision: current.accessRevision,
            createdAt: context.now,
          })
        }
        return {
          displayName: command.displayName,
          gitName: command.gitName,
          email: command.email,
          gitCommitIdentity: { name: command.gitName, email: command.email },
        }
      },
    )
  }
}
