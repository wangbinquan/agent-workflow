// RFC-506 (RFC-294 S10 step 13): the administrator password reset, moved verbatim out of the
// module's composition file userOperations.ts. The system user id, the auth runtime's two credential
// writes, the password hash and the clock are passed in by the composition entry
// (`composeIdentityUserOperations`), like the sibling commands' `systemUserId`. The path of that file
// is deliberately not spelled out here: RFC-347's import lock scans raw source text for it.
import { ValidationError } from '@/util/errors'

export interface ResetUserPasswordDependencies {
  readonly systemUserId: string
  /** The auth runtime's local credential writes (structurally its two methods). */
  readonly credentials: {
    writeLocalPasswordIfUnmanaged(input: {
      readonly userId: string
      readonly passwordHash: string
      readonly forcePasswordChange: boolean
      readonly activate: boolean
      readonly updatedAt: number
    }): Promise<void>
    revokeAllSessionsForUser(userId: string, now: number): Promise<void>
  }
  readonly hashPassword: (plaintext: string) => Promise<string>
  readonly now: () => number
}

export function createResetUserPassword(deps: ResetUserPasswordDependencies) {
  return async function resetPassword({
    userId,
    newPassword,
    force,
  }: {
    userId: string
    newPassword: string
    force?: boolean
  }): Promise<void> {
    if (userId === deps.systemUserId) {
      throw new ValidationError('system-user-immutable', 'cannot reset password for __system__')
    }
    const now = deps.now()
    await deps.credentials.writeLocalPasswordIfUnmanaged({
      userId,
      passwordHash: await deps.hashPassword(newPassword),
      forcePasswordChange: force ?? false,
      activate: true,
      updatedAt: now,
    })
    await deps.credentials.revokeAllSessionsForUser(userId, now)
  }
}
