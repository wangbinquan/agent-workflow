// RFC-036 — user_identities CRUD. Used by both the OIDC callback (auto +
// allowlist + invite paths) and the user-scoped `/account → Linked
// identities` UI (manual link/unlink).

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserIdentity } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { oidcProviders, userIdentities } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import { triggerRevalidation } from '@/ws/revalidationHook'

export async function listIdentitiesForUser(db: DbClient, userId: string): Promise<UserIdentity[]> {
  const rows = await db
    .select({ identity: userIdentities, provider: oidcProviders })
    .from(userIdentities)
    .leftJoin(oidcProviders, eq(oidcProviders.id, userIdentities.providerId))
    .where(eq(userIdentities.userId, userId))
  return rows.map((r) => ({
    id: r.identity.id,
    userId: r.identity.userId,
    providerId: r.identity.providerId,
    providerSlug: r.provider?.slug,
    providerDisplayName: r.provider?.displayName,
    subject: r.identity.subject,
    email: r.identity.email,
    emailVerified: r.identity.emailVerified === 1,
    linkedAt: r.identity.linkedAt,
  }))
}

export async function findByProviderSubject(
  db: DbClient,
  providerId: string,
  subject: string,
): Promise<typeof userIdentities.$inferSelect | null> {
  const rows = await db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.subject, subject)))
    .limit(1)
  return rows[0] ?? null
}

export async function createIdentity(
  db: DbClient,
  args: {
    userId: string
    providerId: string
    subject: string
    email: string | null
    emailVerified: boolean
    now?: number
  },
): Promise<typeof userIdentities.$inferSelect> {
  const existing = await findByProviderSubject(db, args.providerId, args.subject)
  if (existing) {
    throw new ConflictError(
      'identity-already-linked',
      `provider/${args.providerId} subject/${args.subject} is already linked to user ${existing.userId}`,
    )
  }
  const id = ulid()
  const now = args.now ?? Date.now()
  await db.insert(userIdentities).values({
    id,
    userId: args.userId,
    providerId: args.providerId,
    subject: args.subject,
    email: args.email,
    emailVerified: args.emailVerified ? 1 : 0,
    linkedAt: now,
  })
  const rows = await db.select().from(userIdentities).where(eq(userIdentities.id, id)).limit(1)
  return rows[0]!
}

export async function deleteIdentity(db: DbClient, identityId: string): Promise<void> {
  const rows = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.id, identityId))
    .limit(1)
  if (!rows[0]) {
    throw new NotFoundError('identity-not-found', `identity ${identityId} not found`)
  }
  await db.delete(userIdentities).where(eq(userIdentities.id, identityId))
  // RFC-212 — conservative: identity deletion does not touch sessions/PATs, so
  // this rarely closes anything, but keep the write surface uniformly covered.
  triggerRevalidation(db, 'identity-deleted')
}
