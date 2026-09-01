import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserIdentity } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { authLoginPolicy, oidcProviders, userIdentities, users } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { withExistingSQLiteTransactionScope } from '@/platform/persistence/sqlite/existingTransactionScope'
import { ConflictError, NotFoundError } from '@/util/errors'
import { UserAccessError } from '../public/types'
import type {
  CreateOidcIdentityInput,
  OidcIdentityOperations,
  OidcIdentityProfileAccess,
  OidcIdentityRecord,
} from '../application/ports/oidcIdentityCrossContext'

export interface SqliteOidcIdentityCompositionInput {
  readonly db: DbClient
  readonly identityAccess?: OidcIdentityProfileAccess
  readonly onIdentityDeleted?: () => void | Promise<void>
}

function assertProviderSnapshot(tx: DbTxSync, input: CreateOidcIdentityInput): void {
  if (
    input.expectedSubjectClaim === undefined &&
    input.expectedUsernameClaim === undefined &&
    input.expectedGitNameClaim === undefined &&
    input.expectedEmailClaim === undefined
  ) {
    return
  }
  const provider = tx
    .select({
      subjectClaim: oidcProviders.subjectClaim,
      usernameClaim: oidcProviders.usernameClaim,
      gitNameClaim: oidcProviders.gitNameClaim,
      emailClaim: oidcProviders.emailClaim,
    })
    .from(oidcProviders)
    .where(eq(oidcProviders.id, input.providerId))
    .limit(1)
    .get()
  const changed =
    provider === undefined ||
    (input.expectedSubjectClaim !== undefined &&
      (provider.subjectClaim ?? null) !== input.expectedSubjectClaim) ||
    (input.expectedUsernameClaim !== undefined &&
      (provider.usernameClaim ?? null) !== input.expectedUsernameClaim) ||
    (input.expectedGitNameClaim !== undefined &&
      (provider.gitNameClaim ?? null) !== input.expectedGitNameClaim) ||
    (input.expectedEmailClaim !== undefined &&
      (provider.emailClaim ?? null) !== input.expectedEmailClaim)
  if (changed) {
    throw new ConflictError(
      'provider-config-changed',
      'provider identity/profile selectors changed while the sign-in was in flight',
    )
  }
}

function insertIdentity(tx: DbTxSync, input: CreateOidcIdentityInput): OidcIdentityRecord {
  assertProviderSnapshot(tx, input)
  const existing = tx
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.providerId, input.providerId),
        eq(userIdentities.subject, input.subject),
      ),
    )
    .limit(1)
    .get()
  if (existing !== undefined) {
    throw new ConflictError(
      'identity-already-linked',
      `provider/${input.providerId} subject/${input.subject} is already linked to user ${existing.userId}`,
    )
  }
  const record: OidcIdentityRecord = {
    id: ulid(),
    userId: input.userId,
    providerId: input.providerId,
    subject: input.subject,
    email: input.email,
    emailVerified: input.emailVerified ? 1 : 0,
    preferredSnapshot: input.preferredSnapshot ?? null,
    linkedAt: input.now ?? Date.now(),
  }
  tx.insert(userIdentities).values(record).run()
  return record
}

function syncInsertedProfile(
  tx: DbTxSync,
  input: CreateOidcIdentityInput,
  identityAccess: OidcIdentityProfileAccess | undefined,
): void {
  if (
    input.expectedSubjectClaim === undefined &&
    input.expectedUsernameClaim === undefined &&
    input.expectedGitNameClaim === undefined &&
    input.expectedEmailClaim === undefined
  ) {
    return
  }
  if (input.displayName === undefined || input.gitName === undefined) {
    throw new ConflictError(
      'oidc-profile-names-missing',
      'callback identity is missing resolved OIDC profile names',
    )
  }
  if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
  withExistingSQLiteTransactionScope(tx, (transactionScope): undefined => {
    try {
      identityAccess.syncOidcProfileInTransaction(
        transactionScope,
        {
          providerId: input.providerId,
          subject: input.subject,
          userId: input.userId,
          displayName: input.displayName!,
          gitName: input.gitName!,
          email: input.email,
          emailVerified: input.emailVerified,
          ...(input.expectedSubjectClaim !== undefined
            ? { expectedSubjectClaim: input.expectedSubjectClaim }
            : {}),
          ...(input.expectedUsernameClaim !== undefined
            ? { expectedUsernameClaim: input.expectedUsernameClaim }
            : {}),
          ...(input.expectedGitNameClaim !== undefined
            ? { expectedGitNameClaim: input.expectedGitNameClaim }
            : {}),
          ...(input.expectedEmailClaim !== undefined
            ? { expectedEmailClaim: input.expectedEmailClaim }
            : {}),
        },
        input.now ?? Date.now(),
      )
    } catch (error) {
      throw identityAccessDomainError(error)
    }
    return undefined
  })
}

function mapIdentity(row: {
  readonly identity: typeof userIdentities.$inferSelect
  readonly provider: typeof oidcProviders.$inferSelect | null
}): UserIdentity {
  return {
    id: row.identity.id,
    userId: row.identity.userId,
    providerId: row.identity.providerId,
    providerSlug: row.provider?.slug,
    providerDisplayName: row.provider?.displayName,
    subject: row.identity.subject,
    email: row.identity.email,
    emailVerified: row.identity.emailVerified === 1,
    linkedAt: row.identity.linkedAt,
  }
}

export function composeSqliteOidcIdentityOperations(
  input: SqliteOidcIdentityCompositionInput,
): OidcIdentityOperations {
  const { db, identityAccess } = input
  const operations: OidcIdentityOperations = {
    async listIdentitiesForUser(userId) {
      const rows = await db
        .select({ identity: userIdentities, provider: oidcProviders })
        .from(userIdentities)
        .leftJoin(oidcProviders, eq(oidcProviders.id, userIdentities.providerId))
        .where(eq(userIdentities.userId, userId))
      return rows.map(mapIdentity)
    },
    async findByProviderSubject(providerId, subject) {
      const row = await db
        .select()
        .from(userIdentities)
        .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.subject, subject)))
        .limit(1)
      return row[0] ?? null
    },
    async createIdentity(identityInput) {
      return dbTxSync(db, (transaction) => {
        const record = insertIdentity(transaction, identityInput)
        syncInsertedProfile(transaction, identityInput, identityAccess)
        return record
      })
    },
    async createUserWithIdentity(userInput) {
      if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
      const now = userInput.now ?? Date.now()
      try {
        return dbTxSync(db, (transaction) => {
          const policy = transaction
            .select({ oidcDefaultRole: authLoginPolicy.oidcDefaultRole })
            .from(authLoginPolicy)
            .where(eq(authLoginPolicy.id, 'global'))
            .get()
          if (policy === undefined) throw new Error('authentication policy singleton is missing')
          if (userInput.email !== undefined && userInput.email !== null) {
            const conflict = transaction
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, userInput.email))
              .limit(1)
              .get()
            if (conflict !== undefined) {
              throw new ConflictError(
                'oidc-email-conflict',
                'the identity provider email already belongs to another user',
              )
            }
          }
          const userId = ulid()
          const operationId = ulid()
          withExistingSQLiteTransactionScope(transaction, (transactionScope): undefined => {
            identityAccess.initialUserAccess.forTransaction(transactionScope).insert({
              user: {
                id: userId,
                username: userInput.username,
                email: userInput.email ?? null,
                displayName: userInput.displayName,
                gitName: userInput.gitName,
                passwordHash: null,
                role: policy.oidcDefaultRole,
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
          const identityInput = { ...userInput.identity, userId, now }
          insertIdentity(transaction, identityInput)
          syncInsertedProfile(transaction, identityInput, identityAccess)
          return { userId }
        })
      } catch (error) {
        throw identityAccessDomainError(identityAccess.mapOidcEmailConstraint(error))
      }
    },
    async bindInvitedUserWithIdentity(bindInput) {
      if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
      const now = bindInput.now ?? Date.now()
      dbTxSync(db, (transaction) => {
        transaction
          .update(users)
          .set({ status: 'active', updatedAt: now })
          .where(eq(users.id, bindInput.userId))
          .run()
        const identityInput = { ...bindInput.identity, userId: bindInput.userId, now }
        insertIdentity(transaction, identityInput)
        syncInsertedProfile(transaction, identityInput, identityAccess)
        return undefined
      })
    },
    async syncPreferredSnapshot(profileInput) {
      if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
      try {
        return await identityAccess.syncOidcProfile.execute({
          providerId: profileInput.providerId,
          subject: profileInput.subject,
          userId: profileInput.userId,
          displayName: profileInput.displayName,
          gitName: profileInput.gitName,
          email: profileInput.email ?? null,
          emailVerified: profileInput.emailVerified,
          ...(profileInput.expectedSubjectClaim !== undefined
            ? { expectedSubjectClaim: profileInput.expectedSubjectClaim }
            : {}),
          ...(profileInput.expectedUsernameClaim !== undefined
            ? { expectedUsernameClaim: profileInput.expectedUsernameClaim }
            : {}),
          ...(profileInput.expectedGitNameClaim !== undefined
            ? { expectedGitNameClaim: profileInput.expectedGitNameClaim }
            : {}),
          ...(profileInput.expectedEmailClaim !== undefined
            ? { expectedEmailClaim: profileInput.expectedEmailClaim }
            : {}),
        })
      } catch (error) {
        throw identityAccessDomainError(error)
      }
    },
    async unlinkIdentity(identityId) {
      const row = await db
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(eq(userIdentities.id, identityId))
        .limit(1)
      if (row[0] === undefined) {
        throw new NotFoundError('identity-not-found', `identity ${identityId} not found`)
      }
      await db.delete(userIdentities).where(eq(userIdentities.id, identityId))
      await input.onIdentityDeleted?.()
    },
  }
  return Object.freeze(operations)
}

function identityAccessDomainError(error: unknown): unknown {
  if (!(error instanceof UserAccessError)) return error
  if (error.kind === 'not-found') {
    return new NotFoundError(error.code, error.message, error.details)
  }
  return new ConflictError(error.code, error.message, error.details)
}
