// RFC-344/RFC-347 — process-edge bootstrap adapter for the user CLI binding.

import { hashPassword } from '@/auth/passwords'
import { completeBootstrapWithAdmin, isBootstrapRequired } from '@/auth/loginPolicy'
import { userCommand, type UserCommandDeps } from '@/cli/user'
import type { DbClient } from '@/db/client'
import type { InitialUserAccessProvisioner } from '@/modules/identity-access/public/participants'

export type UserCommandIdentityHandle = Pick<
  UserCommandDeps,
  'operations' | 'commandContext' | 'queryContext'
> & { readonly initialUserAccess: InitialUserAccessProvisioner }

export interface UserCommandBootstrapInput {
  readonly db: DbClient
  readonly identity: UserCommandIdentityHandle
  readonly shutdown?: () => void
}

export async function runUserCommand(
  args: string[],
  bootstrap: UserCommandBootstrapInput,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  try {
    return await userCommand(args, {
      ...bootstrap.identity,
      bootstrap: {
        isRequired: () => isBootstrapRequired(bootstrap.db),
        async createFirstAdministrator(input) {
          return completeBootstrapWithAdmin(
            bootstrap.db,
            {
              username: input.username,
              displayName: input.displayName,
              ...(input.email === undefined ? {} : { email: input.email }),
              passwordHash: await hashPassword(input.password),
            },
            bootstrap.identity.initialUserAccess,
          )
        },
      },
    })
  } finally {
    bootstrap.shutdown?.()
  }
}
