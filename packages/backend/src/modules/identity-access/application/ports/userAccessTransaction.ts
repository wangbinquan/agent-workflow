import type { UserAccessAuditTransactionParticipant } from './userAccessAuditRepository'
import type { UserAccessTransactionParticipant } from './userAccessRepository'

type SynchronousDecision<T> = T extends PromiseLike<unknown> ? never : T

export type UserAccessTransaction = UserAccessTransactionParticipant &
  UserAccessAuditTransactionParticipant

/**
 * Exact rows a provider adapter must make available to the synchronous
 * decision callback.  This is data intent, not a database transaction handle:
 * PostgreSQL can await the reads inside its private transaction, while SQLite
 * keeps the callback wholly inside its private transaction boundary.
 */
export interface UserAccessTransactionReadSet {
  /** Maps provider constraint races back to the command's closed error contract. */
  readonly operation?:
    | 'create-managed-user'
    | 'update-user-access'
    | 'update-own-profile'
    | 'sync-oidc-profile'
  readonly userIds?: ReadonlyArray<string>
  readonly usernames?: ReadonlyArray<string>
  readonly emails?: ReadonlyArray<string>
  readonly grantUserIds?: ReadonlyArray<string>
  readonly oidcProfileIdentity?: Readonly<{
    providerId: string
    subject: string
  }>
  readonly oidcProfileSelectorsProviderId?: string
  /** Needed only by the last-access-administrator invariant. */
  readonly activeAccessAdministrators?: true
}

export interface UserAccessTransactionRunner {
  run<T>(
    readSet: UserAccessTransactionReadSet,
    body: (transaction: UserAccessTransaction) => SynchronousDecision<T>,
  ): Promise<T>
}
