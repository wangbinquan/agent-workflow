// RFC-036 — user_identities CRUD. Used by both the OIDC callback (auto +
// allowlist + invite paths) and the user-scoped `/account → Linked
// identities` UI (manual link/unlink).

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserIdentity } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { authLoginPolicy, oidcProviders, userIdentities, users } from '@/db/schema'
import { insertInitialUserAccessInTransaction } from '@/modules/identity-access/public/commands'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { withExistingSQLiteTransactionScope } from '@/platform/persistence/sqlite/existingTransactionScope'
import {
  mapOidcUserProfilePersistenceError,
  syncOidcUserProfile,
  syncOidcUserProfileInTransaction,
} from '@/services/users'
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
  /** RFC-320 — profile selector snapshots share the same callback/write fence. */
  expectedUsernameClaim?: string | null
  expectedEmailClaim?: string | null
  now?: number
}

function assertProviderSnapshot(
  tx: DbTxSync,
  args: Pick<
    CreateIdentityArgs,
    'providerId' | 'expectedSubjectClaim' | 'expectedUsernameClaim' | 'expectedEmailClaim'
  >,
): void {
  if (
    args.expectedSubjectClaim === undefined &&
    args.expectedUsernameClaim === undefined &&
    args.expectedEmailClaim === undefined
  ) {
    return
  }
  const provider = tx
    .select({
      subjectClaim: oidcProviders.subjectClaim,
      usernameClaim: oidcProviders.usernameClaim,
      emailClaim: oidcProviders.emailClaim,
    })
    .from(oidcProviders)
    .where(eq(oidcProviders.id, args.providerId))
    .limit(1)
    .all()[0]
  const changed =
    provider === undefined ||
    (args.expectedSubjectClaim !== undefined &&
      (provider.subjectClaim ?? null) !== args.expectedSubjectClaim) ||
    (args.expectedUsernameClaim !== undefined &&
      (provider.usernameClaim ?? null) !== args.expectedUsernameClaim) ||
    (args.expectedEmailClaim !== undefined &&
      (provider.emailClaim ?? null) !== args.expectedEmailClaim)
  if (changed) {
    throw new ConflictError(
      'provider-config-changed',
      'provider identity/profile selectors changed while the sign-in was in flight',
    )
  }
}

function insertIdentityTx(
  tx: DbTxSync,
  args: CreateIdentityArgs,
): typeof userIdentities.$inferSelect {
  assertProviderSnapshot(tx, args)
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
  return dbTxSync(db, (tx) => {
    const identity = insertIdentityTx(tx, args)
    syncInsertedIdentityProfile(db, tx, args.userId, args, args.now ?? Date.now())
    return identity
  })
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
    email?: string | null
    identity: Omit<CreateIdentityArgs, 'userId'>
    now?: number
  },
): Promise<{ userId: string }> {
  const now = args.now ?? Date.now()
  try {
    return dbTxSync(db, (tx) => {
      // The policy read and account insert share the same SQLite transaction.
      // A concurrent administrator change therefore has one linearization point:
      // the new account receives either the complete old preset or the complete
      // new preset, never a route-level stale snapshot.
      const policy = tx
        .select({ oidcDefaultRole: authLoginPolicy.oidcDefaultRole })
        .from(authLoginPolicy)
        .where(eq(authLoginPolicy.id, 'global'))
        .get()
      if (policy === undefined) {
        throw new Error('authentication policy singleton is missing')
      }
      if (args.email !== undefined && args.email !== null) {
        const conflict = tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, args.email))
          .limit(1)
          .all()[0]
        if (conflict !== undefined) {
          throw new ConflictError(
            'oidc-email-conflict',
            'the identity provider email already belongs to another user',
          )
        }
      }
      const userId = ulid()
      const operationId = ulid()
      withExistingSQLiteTransactionScope(tx, (transactionScope) => {
        insertInitialUserAccessInTransaction(transactionScope, {
          user: {
            id: userId,
            username: args.username,
            email: args.email ?? null,
            displayName: args.displayName,
            passwordHash: null,
            // Only self-provisioning consults this policy. Invited identities
            // retain the administrator-selected preset in the bind path below.
            role: policy.oidcDefaultRole,
            // The IdP verified the identity, so the user lands as `active`
            // immediately (same rationale as the pre-RFC-220 createUser call).
            status: 'active',
            forcePasswordChange: false,
            createdBy: null,
            createdAt: now,
          },
          audit: {
            id: ulid(),
            actorUserId: null,
            actorKind: 'system',
            operationId,
          },
        })
        return undefined
      })
      const identityArgs = { ...args.identity, userId, now }
      insertIdentityTx(tx, identityArgs)
      syncInsertedIdentityProfile(db, tx, userId, identityArgs, now)
      return { userId }
    })
  } catch (error) {
    throw identityAccessDomainError(mapOidcUserProfilePersistenceError(db, error))
  }
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
    tx.update(users)
      .set({ status: 'active', updatedAt: now })
      .where(eq(users.id, args.userId))
      .run()
    const identityArgs = { ...args.identity, userId: args.userId, now }
    insertIdentityTx(tx, identityArgs)
    syncInsertedIdentityProfile(db, tx, args.userId, identityArgs, now)
    return undefined
  })
}

function syncInsertedIdentityProfile(
  db: DbClient,
  tx: DbTxSync,
  userId: string,
  identity: CreateIdentityArgs,
  now: number,
): void {
  // Undefined on all three fields is the pre-RFC direct-link API. Callback
  // flows snapshot at least subjectClaim and RFC-320 snapshots all three.
  if (
    identity.expectedSubjectClaim === undefined &&
    identity.expectedUsernameClaim === undefined &&
    identity.expectedEmailClaim === undefined
  ) {
    return
  }
  withExistingSQLiteTransactionScope(tx, (transactionScope) => {
    try {
      syncOidcUserProfileInTransaction(
        db,
        transactionScope,
        {
          providerId: identity.providerId,
          subject: identity.subject,
          userId,
          composed: identity.preferredSnapshot === '' ? null : (identity.preferredSnapshot ?? null),
          email: identity.email,
          emailVerified: identity.emailVerified,
          usernameClaimConfigured:
            identity.expectedUsernameClaim !== undefined
              ? identity.expectedUsernameClaim !== null
              : identity.preferredSnapshot !== null,
          ...(identity.expectedSubjectClaim !== undefined
            ? { expectedSubjectClaim: identity.expectedSubjectClaim }
            : {}),
          ...(identity.expectedUsernameClaim !== undefined
            ? { expectedUsernameClaim: identity.expectedUsernameClaim }
            : {}),
          ...(identity.expectedEmailClaim !== undefined
            ? { expectedEmailClaim: identity.expectedEmailClaim }
            : {}),
        },
        now,
      )
    } catch (error) {
      throw identityAccessDomainError(error)
    }
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
    /** RFC-320 — normalized IdP email snapshot; null means absent standard claim. */
    email?: string | null
    /** Normalized claims value (post applyEmailTrust) — synced bidirectionally. */
    emailVerified: boolean
    /** D7 refresh only runs for providers with usernameClaim configured. */
    usernameClaimConfigured: boolean
    expectedSubjectClaim?: string | null
    expectedUsernameClaim?: string | null
    expectedEmailClaim?: string | null
    now?: number
  },
): { displayNameRefreshed: boolean; emailRefreshed: boolean } {
  try {
    return syncOidcUserProfile(db, {
      providerId: args.providerId,
      subject: args.subject,
      userId: args.userId,
      composed: args.composed,
      email: args.email ?? null,
      emailVerified: args.emailVerified,
      usernameClaimConfigured: args.usernameClaimConfigured,
      ...(args.expectedSubjectClaim !== undefined
        ? { expectedSubjectClaim: args.expectedSubjectClaim }
        : {}),
      ...(args.expectedUsernameClaim !== undefined
        ? { expectedUsernameClaim: args.expectedUsernameClaim }
        : {}),
      ...(args.expectedEmailClaim !== undefined
        ? { expectedEmailClaim: args.expectedEmailClaim }
        : {}),
    })
  } catch (error) {
    throw identityAccessDomainError(error)
  }
}

function identityAccessDomainError(error: unknown): unknown {
  if (!(error instanceof UserAccessError)) return error
  if (error.kind === 'not-found') return new NotFoundError(error.code, error.message, error.details)
  return new ConflictError(error.code, error.message, error.details)
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
