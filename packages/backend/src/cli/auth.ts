// RFC-221 — local-only recovery for the username/password login policy.
// Deliberately no command can reopen the retired daemon bootstrap token.

import { existsSync, readdirSync } from 'node:fs'
import { openDb } from '@/db/client'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { getAuthLoginPolicy, setPasswordLoginEnabled } from '@/auth/loginPolicy'
import { Paths } from '@/util/paths'

async function openPolicyDb() {
  const migrationsFolder = await resolveMigrationsFolder()
  if (!existsSync(migrationsFolder) || readdirSync(migrationsFolder).length === 0) {
    throw new Error(`migrations not found: ${migrationsFolder}`)
  }
  return openDb({ path: Paths.db, migrationsFolder })
}

export async function authCommand(
  args: string[],
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const [area, action] = args
  if (area !== 'password-login' || (action !== 'status' && action !== 'enable')) {
    return {
      output: 'usage: agent-workflow auth password-login <status|enable>\n',
      status: 'error',
    }
  }
  try {
    const db = await openPolicyDb()
    if (action === 'status') {
      const policy = getAuthLoginPolicy(db)
      return {
        output:
          `password login: ${policy.passwordLoginEnabled ? 'enabled' : 'disabled'}\n` +
          `bootstrap: ${policy.bootstrapCompletedAt === null ? 'required' : 'complete (daemon token retired)'}\n`,
        status: 'ok',
      }
    }
    const policy = setPasswordLoginEnabled(db, true)
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
