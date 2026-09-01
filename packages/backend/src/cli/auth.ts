// RFC-221 — local-only recovery for the username/password login policy.
// Deliberately no command can reopen the retired daemon bootstrap token.

import type { AuthRuntime } from '@/auth/application/authRuntime'

export async function authCommand(
  args: string[],
  auth: AuthRuntime,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const [area, action] = args
  if (area !== 'password-login' || (action !== 'status' && action !== 'enable')) {
    return {
      output: 'usage: agent-workflow auth password-login <status|enable>\n',
      status: 'error',
    }
  }
  try {
    if (action === 'status') {
      const policy = await auth.getLoginPolicy()
      return {
        output:
          `password login: ${policy.passwordLoginEnabled ? 'enabled' : 'disabled'}\n` +
          `bootstrap: ${policy.bootstrapCompletedAt === null ? 'required' : 'complete (daemon token retired)'}\n`,
        status: 'ok',
      }
    }
    const policy = await auth.setPasswordLoginEnabled(true)
    return {
      output: `password login enabled (updatedAt=${policy.updatedAt}); daemon token remains retired\n`,
      status: 'ok',
    }
  } catch (error) {
    return {
      output: `error: ${error instanceof Error ? error.message : String(error)}\n`,
      status: 'error',
    }
  }
}
