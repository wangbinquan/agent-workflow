// RFC-036 — user_identities CRUD. Used by both the OIDC callback (auto +
// allowlist + invite paths) and the user-scoped `/account → Linked
// identities` UI (manual link/unlink).

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserIdentity } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { oidcProviders, userIdentities, users } from '@/db/schema'
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

export interface CreateIdentityArgs {
  userId: string
  providerId: string
  subject: string
  email: string | null
  emailVerified: boolean
  /** RFC-220 D7 — initial presented-name snapshot ('' = observed-but-absent
   * sentinel). Omitted (legacy callers) → NULL, the never-observed state. */
  preferredSnapshot?: string | null
  /**
   * RFC-220 — the callback's snapshot of provider.subjectClaim. When provided
   * (undefined = no check, for non-callback callers) the insert re-reads the
   * provider INSIDE the transaction and refuses on mismatch: an in-flight
   * callback that resolved claims under the old subject namespace must not
   * persist a row into the new one (write-time TOCTOU gate, design §2.3).
   */
  expectedSubjectClaim?: string | null
  now?: number
}

function insertIdentityTx(tx: DbTxSync, args: CreateIdentityArgs): typeof userIdentities.$inferSelect {
  if (args.expectedSubjectClaim !== undefined) {
    const provider = tx
      .select({ subjectClaim: oidcProviders.subjectClaim })
      .from(oidcProviders)
      .where(eq(oidcProviders.id, args.providerId))
      .limit(1)
      .all()
    const current = provider[0]?.subjectClaim ?? null
    if (current !== args.expectedSubjectClaim) {
      throw new ConflictError(
        'provider-config-changed',
        'provider subjectClaim changed while the sign-in was in flight',
      )
    }
  }
  const existing = tx
    .select()
    .from(userIdentities)
    .where(
      and(eq(userIdentities.providerId, args.providerId), eq(userIdentities.subject, args.subject)),
    )
    .limit(1)
    .all()
  if (existing[0]) {
    throw new ConflictError(
      'identity-already-linked',
      `provider/${args.providerId} subject/${args.subject} is already linked to user ${existing[0].userId}`,
    )
  }
  const id = ulid()
  const now = args.now ?? Date.now()
  tx.insert(userIdentities)
    .values({
      id,
      userId: args.userId,
      providerId: args.providerId,
      subject: args.subject,
      email: args.email,
      emailVerified: args.emailVerified ? 1 : 0,
      preferredSnapshot: args.preferredSnapshot ?? null,
      linkedAt: now,
    })
    .run()
  return tx.select().from(userIdentities).where(eq(userIdentities.id, id)).limit(1).all()[0]!
}

export async function createIdentity(
  db: DbClient,
  args: CreateIdentityArgs,
): Promise<typeof userIdentities.$inferSelect> {
  // dbTxSync (not a plain insert): the duplicate check, the subjectClaim
  // revalidation, and the insert must be one serialization unit against the
  // PATCH-side namespace lock (services/oidcProviders.ts).
  return dbTxSync(db, (tx) => insertIdentityTx(tx, args))
}

/**
 * RFC-220 — auto-provisioning writes the user row AND its identity in ONE
 * synchronous transaction: a subjectClaim mismatch (or any failure) must roll
 * back both, or a crash/config-race leaves an identity-less active account
 * behind (design §6.2, gate round 5 P1).
 */
export async function createUserWithIdentity(
  db: DbClient,
  args: {
    username: string
    displayName: string
    email: string | null
    identity: Omit<CreateIdentityArgs, 'userId'>
    now?: number
  },
): Promise<{ userId: string }> {
  const now = args.now ?? Date.now()
  return dbTxSync(db, (tx) => {
    const userId = ulid()
    tx.insert(users)
      .values({
        id: userId,
        username: args.username,
        email: args.email,
        displayName: args.displayName,
        passwordHash: null,
        role: 'user',
        // The IdP verified the identity, so the user lands as `active`
        // immediately (same rationale as the pre-RFC-220 createUser call).
        status: 'active',
        forcePasswordChange: false,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        schemaVersion: 1,
      })
      .run()
    insertIdentityTx(tx, { ...args.identity, userId, now })
    return { userId }
  })
}

/**
 * RFC-220 — invite binding, same atomicity rationale: activating the invited
 * user and linking the identity either both happen or neither does (a
 * half-activated invite would no longer match `findInvitedByEmail`).
 */
export async function bindInvitedUserWithIdentity(
  db: DbClient,
  args: {
    userId: string
    identity: Omit<CreateIdentityArgs, 'userId'>
    now?: number
  },
): Promise<void> {
  const now = args.now ?? Date.now()
  dbTxSync(db, (tx) => {
    tx.update(users).set({ status: 'active', updatedAt: now }).where(eq(users.id, args.userId)).run()
    insertIdentityTx(tx, { ...args.identity, userId: args.userId, now })
    return undefined
  })
}

/**
 * RFC-220 D7 — presented-name follow + email_verified sync on the existing-
 * identity login path (design §5.3). Three-way merge against the last-seen
 * IdP value, NOT against displayName — an in-app rename survives until the
 * IdP-side value actually changes.
 *
 * Snapshot domain: '' = observed-but-absent sentinel, NULL = legacy row
 * (pre-RFC-220) whose first sight must only record, never overwrite.
 * All writes share one synchronous transaction: a snapshot persisted without
 * its displayName update would make every later login a silent no-op.
 */
export function syncPreferredSnapshot(
  db: DbClient,
  args: {
    providerId: string
    subject: string
    userId: string
    /** composePreferred result; null when the claim list yielded nothing. */
    composed: string | null
    /** Normalized claims value (post applyEmailTrust) — synced bidirectionally. */
    emailVerified: boolean
    /** D7 refresh only runs for providers with usernameClaim configured. */
    usernameClaimConfigured: boolean
    now?: number
  },
): { displayNameRefreshed: boolean } {
  const now = args.now ?? Date.now()
  return dbTxSync(db, (tx) => {
    const rows = tx
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.providerId, args.providerId),
          eq(userIdentities.subject, args.subject),
        ),
      )
      .limit(1)
      .all()
    const identity = rows[0]
    if (!identity) return { displayNameRefreshed: false }

    const wantVerified = args.emailVerified ? 1 : 0
    if (identity.emailVerified !== wantVerified) {
      // trustEmailVerified toggled after the identity was created: the stored
      // flag follows the normalized claims (gate round 6 — without this, an
      // existing identity would stay unverified forever).
      tx.update(userIdentities)
        .set({ emailVerified: wantVerified })
        .where(eq(userIdentities.id, identity.id))
        .run()
    }

    if (!args.usernameClaimConfigured) return { displayNameRefreshed: false }

    const cur = args.composed ?? ''
    const snapshot = identity.preferredSnapshot
    if (snapshot === null) {
      // Legacy row: record only. Overwriting on first sight could clobber an
      // in-app rename that predates RFC-220.
      tx.update(userIdentities)
        .set({ preferredSnapshot: cur })
        .where(eq(userIdentities.id, identity.id))
        .run()
      return { displayNameRefreshed: false }
    }
    if (snapshot === cur) return { displayNameRefreshed: false }
    if (cur === '') {
      // IdP-side value disappeared: track it, but a missing value never
      // clears the presented name.
      tx.update(userIdentities)
        .set({ preferredSnapshot: cur })
        .where(eq(userIdentities.id, identity.id))
        .run()
      return { displayNameRefreshed: false }
    }
    tx.update(userIdentities)
      .set({ preferredSnapshot: cur })
      .where(eq(userIdentities.id, identity.id))
      .run()
    tx.update(users)
      .set({ displayName: cur, updatedAt: now })
      .where(eq(users.id, args.userId))
      .run()
    return { displayNameRefreshed: true }
  })
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
