// RFC-344 — process-edge composition for the user CLI binding.

import { openDb } from '@/db/client'
import { hashPassword } from '@/auth/passwords'
import { completeBootstrapWithAdmin, isBootstrapRequired } from '@/auth/loginPolicy'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { userCommand } from '@/cli/user'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'

export async function runUserCommand(
  args: string[],
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const migrationsFolder = await resolveMigrationsFolder()
  const db = openDb({ path: Paths.db, migrationsFolder })
  const identityAccess = composeIdentityAccess(db)
  const operations = composeIdentityUserOperations({ db, identityAccess })
  const principal = { userId: SYSTEM_USER_ID, source: 'cli' } as const

  return userCommand(args, {
    operations,
    commandContext: () => identityAccess.contexts.fromAuthenticatedPrincipal(principal, 'cli'),
    queryContext: () => identityAccess.contexts.queryFromAuthenticatedPrincipal(principal, 'cli'),
    bootstrap: {
      isRequired: () => isBootstrapRequired(db),
      async createFirstAdministrator(input) {
        return completeBootstrapWithAdmin(db, {
          username: input.username,
          displayName: input.displayName,
          ...(input.email === undefined ? {} : { email: input.email }),
          passwordHash: await hashPassword(input.password),
        })
      },
    },
  })
}
