import { UserAccessError } from '../../public/types'
import type { UserAccessTransaction } from '../ports/userAccessTransaction'
import type { UserAccessTransactionRunner } from '../ports/userAccessTransaction'

export interface SyncOidcProfileCommand {
  readonly providerId: string
  readonly subject: string
  readonly userId: string
  /** Composed configured username fields; null means observed but absent. */
  readonly composed: string | null
  /** Normalized email claim. Null means an optional standard claim was absent. */
  readonly email: string | null
  readonly emailVerified: boolean
  readonly usernameClaimConfigured: boolean
  /** Callback callers provide all three; omitted only by pre-RFC compatibility callers. */
  readonly expectedSubjectClaim?: string | null
  readonly expectedUsernameClaim?: string | null
  readonly expectedEmailClaim?: string | null
}

export interface SyncOidcProfileResult {
  readonly displayNameRefreshed: boolean
  readonly emailRefreshed: boolean
}

interface SyncOidcProfileExecutionDeps {
  readonly auditId: () => string
  readonly operationId: () => string
  readonly now: () => number
}

export class SyncOidcProfile {
  constructor(
    private readonly deps: SyncOidcProfileExecutionDeps & {
      readonly transactions: UserAccessTransactionRunner
    },
  ) {}

  execute(command: SyncOidcProfileCommand): SyncOidcProfileResult {
    try {
      const now = this.deps.now()
      const operationId = this.deps.operationId()
      return this.deps.transactions.run((transaction) =>
        syncOidcProfileTransaction(transaction, command, {
          now,
          operationId,
          auditId: this.deps.auditId,
        }),
      )
    } catch (error) {
      throw mapOidcEmailConstraint(error)
    }
  }
}

export function syncOidcProfileTransaction(
  transaction: UserAccessTransaction,
  command: SyncOidcProfileCommand,
  execution: {
    readonly now: number
    readonly operationId: string
    readonly auditId: () => string
  },
): SyncOidcProfileResult {
  const selectors = transaction.findOidcProfileSelectors(command.providerId)
  if (
    selectors === null ||
    (command.expectedSubjectClaim !== undefined &&
      selectors.subjectClaim !== command.expectedSubjectClaim) ||
    (command.expectedUsernameClaim !== undefined &&
      selectors.usernameClaim !== command.expectedUsernameClaim) ||
    (command.expectedEmailClaim !== undefined &&
      selectors.emailClaim !== command.expectedEmailClaim)
  ) {
    throw new UserAccessError(
      'conflict',
      'provider-config-changed',
      'provider identity/profile selectors changed while sign-in was in flight',
    )
  }

  const identity = transaction.findOidcProfileIdentity(command.providerId, command.subject)
  if (identity === null) {
    throw new UserAccessError('not-found', 'identity-not-found', 'OIDC identity was not found')
  }
  if (identity.userId !== command.userId) {
    throw new UserAccessError(
      'conflict',
      'identity-user-mismatch',
      'OIDC identity belongs to a different user',
    )
  }
  const user = transaction.findUser(command.userId)
  if (user === null) {
    throw new UserAccessError('not-found', 'user-not-found', 'OIDC user was not found')
  }

  let nextEmail = user.email
  let emailRefreshed = false
  const identityUpdate: {
    id: string
    email?: string
    emailVerified?: boolean
    preferredSnapshot?: string
  } = { id: identity.id }

  if (command.email !== null) {
    const idpEmailChanged = identity.email !== null && identity.email !== command.email
    if (user.email === null || idpEmailChanged) {
      const conflict = transaction.findUserByEmail(command.email)
      if (conflict !== null && conflict.id !== user.id) {
        throw new UserAccessError(
          'conflict',
          'oidc-email-conflict',
          'the identity provider email already belongs to another user',
        )
      }
      if (user.email !== command.email) {
        nextEmail = command.email
        emailRefreshed = true
      }
    }
    if (identity.email !== command.email) identityUpdate.email = command.email
  }
  if (identity.emailVerified !== command.emailVerified) {
    identityUpdate.emailVerified = command.emailVerified
  }

  let nextDisplayName = user.displayName
  let displayNameRefreshed = false
  if (command.usernameClaimConfigured) {
    const currentClaim = command.composed ?? ''
    if (identity.preferredSnapshot === null) {
      // Legacy row: first sight records the IdP snapshot but never overwrites a
      // possibly intentional in-app rename.
      identityUpdate.preferredSnapshot = currentClaim
    } else if (identity.preferredSnapshot !== currentClaim) {
      identityUpdate.preferredSnapshot = currentClaim
      if (currentClaim !== '' && user.displayName !== currentClaim) {
        nextDisplayName = currentClaim
        displayNameRefreshed = true
      }
    }
  }

  if (Object.keys(identityUpdate).length > 1) {
    transaction.updateOidcProfileIdentity(identityUpdate)
  }
  if (emailRefreshed || displayNameRefreshed) {
    const updated = transaction.updateUserConditional({
      id: user.id,
      expectedAccessRevision: user.accessRevision,
      accessChanged: false,
      values: {
        displayName: nextDisplayName,
        email: nextEmail,
        updatedAt: execution.now,
      },
    })
    if (!updated) {
      throw new UserAccessError('conflict', 'profile-update-conflict', 'OIDC profile changed')
    }
    transaction.appendAudit({
      id: execution.auditId(),
      targetUserId: user.id,
      actorUserId: null,
      actorKind: 'system',
      operationId: execution.operationId,
      correlationId: execution.operationId,
      beforeRole: user.role,
      afterRole: user.role,
      addedPermissions: [],
      removedPermissions: [],
      accessRevision: user.accessRevision,
      createdAt: execution.now,
    })
  }

  return { displayNameRefreshed, emailRefreshed }
}

export function mapOidcEmailConstraint(error: unknown): unknown {
  if (error instanceof UserAccessError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/UNIQUE constraint failed:\s*users\.email|users_email_unique/i.test(message)) {
    return new UserAccessError(
      'conflict',
      'oidc-email-conflict',
      'the identity provider email already belongs to another user',
    )
  }
  return error
}
