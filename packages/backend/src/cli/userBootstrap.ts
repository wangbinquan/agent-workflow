// RFC-344/RFC-347 — process-edge bootstrap adapter for the user CLI binding.

import { hashPassword } from '@/auth/passwords'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import { userCommand, type UserCommandDeps } from '@/cli/user'

export type UserCommandIdentityHandle = Pick<
  UserCommandDeps,
  'operations' | 'commandContext' | 'queryContext'
>

export interface UserCommandBootstrapInput {
  readonly auth: AuthRuntime
  readonly identity: UserCommandIdentityHandle
  readonly shutdown?: () => void | Promise<void>
}

export async function runUserCommand(
  args: string[],
  bootstrap: UserCommandBootstrapInput,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  try {
    const bootstrapRequired =
      args[0] === 'create' ? await bootstrap.auth.isBootstrapRequired() : false
    return await userCommand(args, {
      ...bootstrap.identity,
      bootstrap: {
        isRequired: () => bootstrapRequired,
        async createFirstAdministrator(input) {
          return await bootstrap.auth.completeBootstrap({
            username: input.username,
            displayName: input.displayName,
            ...(input.email === undefined ? {} : { email: input.email }),
            passwordHash: await hashPassword(input.password),
          })
        },
      },
    })
  } finally {
    await bootstrap.shutdown?.()
  }
}
