// RFC-221/RFC-349 — compatibility names over the provider-neutral auth
// runtime. Provider selection belongs to bootstrap and never reaches callers.

import type { AuthRuntime } from '@/auth/application/authRuntime'

export async function isOidcManagedUser(auth: AuthRuntime, userId: string): Promise<boolean> {
  return await auth.isOidcManagedUser(userId)
}

export async function listOidcManagedUserIds(
  auth: AuthRuntime,
  userIds?: readonly string[],
): Promise<Set<string>> {
  return new Set(await auth.listOidcManagedUserIds(userIds))
}

/**
 * Linearization point shared by self-service and admin password writes. The
 * provider adapter rechecks identity ownership and updates the password in one
 * transaction, so a password can never commit after an OIDC identity link.
 */
export async function writeLocalPasswordIfUnmanaged(
  auth: AuthRuntime,
  input: {
    userId: string
    passwordHash: string
    forcePasswordChange: boolean
    activate: boolean
    updatedAt: number
  },
): Promise<void> {
  await auth.writeLocalPasswordIfUnmanaged(input)
}
