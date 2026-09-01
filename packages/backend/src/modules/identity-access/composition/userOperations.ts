// RFC-344 — bootstrap composition for the identity-access operation cohort.

import { ulid } from 'ulid'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { hashPassword } from '@/auth/passwords'
import type { IdentityAccessModule } from '@/modules/identity-access/composition'
import {
  createIdentityUserOperations,
  type IdentityUserOperations,
} from '@/modules/identity-access/public/operations'
import { ValidationError } from '@/util/errors'

export function composeIdentityUserOperations(input: {
  readonly identityAccess: IdentityAccessModule
  readonly auth: AuthRuntime
  readonly afterDisabled?: (userId: string) => Promise<void>
}): IdentityUserOperations {
  return createIdentityUserOperations({
    contexts: input.identityAccess.contexts,
    createManagedUser: input.identityAccess.createManagedUser,
    updateUserAccess: input.identityAccess.updateUserAccess,
    getUserAccess: input.identityAccess.getUserAccess,
    id: ulid,
    hashPassword,
    oidcManagedUserIds: (userIds) => input.auth.listOidcManagedUserIds(userIds),
    isOidcManagedUser: (userId) => input.auth.isOidcManagedUser(userId),
    searchUsers: async (query) => [...(await input.identityAccess.userDirectory.search(query))],
    lookupUsers: async (ids) => [...(await input.identityAccess.userDirectory.lookup(ids))],
    async resetPassword({ userId, newPassword, force }) {
      if (userId === SYSTEM_USER_ID) {
        throw new ValidationError('system-user-immutable', 'cannot reset password for __system__')
      }
      const now = Date.now()
      await input.auth.writeLocalPasswordIfUnmanaged({
        userId,
        passwordHash: await hashPassword(newPassword),
        forcePasswordChange: force ?? false,
        activate: true,
        updatedAt: now,
      })
      await input.auth.revokeAllSessionsForUser(userId, now)
    },
    async afterDisabled({ userId, at }) {
      await input.auth.revokeAllSessionsForUser(userId, at)
      await input.afterDisabled?.(userId)
    },
  })
}
