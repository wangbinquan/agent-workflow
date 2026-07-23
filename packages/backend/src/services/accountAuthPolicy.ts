// RFC-221 — account-level credential ownership. A user with any linked OIDC
// identity is provider-managed regardless of which credential opened the
// current session.

import { inArray, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { userIdentities, users } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { ForbiddenError, NotFoundError } from '@/util/errors'

export async function isOidcManagedUser(db: DbClient, userId: string): Promise<boolean> {
  const row = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .limit(1)
  return row.length > 0
}

export async function listOidcManagedUserIds(
  db: DbClient,
  userIds?: readonly string[],
): Promise<Set<string>> {
  const wanted = userIds === undefined ? undefined : [...new Set(userIds)]
  if (wanted !== undefined && wanted.length === 0) return new Set()
  const base = db.select({ userId: userIdentities.userId }).from(userIdentities)
  const rows =
    wanted === undefined ? await base : await base.where(inArray(userIdentities.userId, wanted))
  return new Set(rows.map((row) => row.userId))
}

/**
 * Linearization point shared by self-service and admin password writes.
 * OIDC callback identity insertion uses the same synchronous transaction
 * mechanism, so a password write can never commit after a linked identity.
 */
export function writeLocalPasswordIfUnmanaged(
  db: DbClient,
  input: {
    userId: string
    passwordHash: string
    forcePasswordChange: boolean
    activate: boolean
    updatedAt: number
  },
): void {
  dbTxSync(db, (tx) => {
    const user = tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get()
    if (user === undefined) {
      throw new NotFoundError('user-not-found', `user ${input.userId} not found`)
    }
    const linked = tx
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(eq(userIdentities.userId, input.userId))
      .limit(1)
      .get()
    if (linked !== undefined) {
      throw new ForbiddenError(
        'oidc-password-managed',
        'password is managed by the linked identity provider',
      )
    }
    tx.update(users)
      .set({
        passwordHash: input.passwordHash,
        forcePasswordChange: input.forcePasswordChange,
        ...(input.activate ? { status: 'active' as const } : {}),
        updatedAt: input.updatedAt,
      })
      .where(eq(users.id, input.userId))
      .run()
  })
}
