// RFC-344 — bootstrap composition for the identity-access operation cohort.

import { ulid } from 'ulid'
import { hashPassword } from '@/auth/passwords'
import { revokeAllSessionsForUser } from '@/auth/sessionStore'
import type { DbClient } from '@/db/client'
import type { IdentityAccessModule } from '@/modules/identity-access/composition'
import {
  createIdentityUserOperations,
  type IdentityUserOperations,
} from '@/modules/identity-access/public/operations'
import { isOidcManagedUser, listOidcManagedUserIds } from '@/services/accountAuthPolicy'
import { lookupUsersPublic, resetPassword, searchUsersPublic } from '@/services/users'

export function composeIdentityUserOperations(input: {
  readonly db: DbClient
  readonly identityAccess: IdentityAccessModule
  readonly afterDisabled?: (userId: string) => Promise<void>
}): IdentityUserOperations {
  return createIdentityUserOperations({
    contexts: input.identityAccess.contexts,
    createManagedUser: input.identityAccess.createManagedUser,
    updateUserAccess: input.identityAccess.updateUserAccess,
    getUserAccess: input.identityAccess.getUserAccess,
    id: ulid,
    hashPassword,
    oidcManagedUserIds: (userIds) => listOidcManagedUserIds(input.db, userIds),
    isOidcManagedUser: (userId) => isOidcManagedUser(input.db, userId),
    searchUsers: (query) => searchUsersPublic(input.db, query),
    lookupUsers: (ids) => lookupUsersPublic(input.db, ids),
    resetPassword: ({ userId, newPassword, force }) =>
      resetPassword(input.db, userId, { newPassword, force }),
    async afterDisabled({ userId, at }) {
      await revokeAllSessionsForUser(input.db, userId, at)
      await input.afterDisabled?.(userId)
    },
  })
}
