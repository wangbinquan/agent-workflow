// RFC-036/RFC-349 — compatibility facade for legacy tests and setup callers.
// Production HTTP/OIDC routes receive the identity operations from bootstrap;
// RFC-359 W4-D8 起两个 provider 共用同一份实现，这里只是 db 参数形态的旧门面。

import { composeOidcIdentityOperations } from '@/modules/identity-access/composition/providerOperations'
import type { OidcIdentityProfileAccess } from '@/modules/identity-access/public/operations'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { ConflictError, NotFoundError } from '@/util/errors'
import { triggerRevalidation } from '@/ws/revalidationHook'

type SqliteIdentityCompositionInput = Parameters<typeof composeOidcIdentityOperations>[0]
type SqliteIdentityDatabase = SqliteIdentityCompositionInput['db']
type ComposedIdentityOperations = ReturnType<typeof composeOidcIdentityOperations>

export type OidcProfileIdentityAccess = OidcIdentityProfileAccess
export type CreateIdentityArgs = Parameters<ComposedIdentityOperations['createIdentity']>[0]

function sqliteOperations(
  db: SqliteIdentityDatabase,
  identityAccess?: OidcProfileIdentityAccess,
): ComposedIdentityOperations {
  return composeOidcIdentityOperations({
    db,
    ...(identityAccess === undefined ? {} : { identityAccess }),
    onIdentityDeleted: () => triggerRevalidation('identity-deleted'),
  })
}

export async function listIdentitiesForUser(db: SqliteIdentityDatabase, userId: string) {
  return await sqliteOperations(db).listIdentitiesForUser(userId)
}

export async function findByProviderSubject(
  db: SqliteIdentityDatabase,
  providerId: string,
  subject: string,
) {
  return await sqliteOperations(db).findByProviderSubject(providerId, subject)
}

export async function createIdentity(
  db: SqliteIdentityDatabase,
  args: CreateIdentityArgs,
  identityAccess?: OidcProfileIdentityAccess,
) {
  return await sqliteOperations(db, identityAccess).createIdentity(args)
}

export async function createUserWithIdentity(
  db: SqliteIdentityDatabase,
  args: Parameters<ComposedIdentityOperations['createUserWithIdentity']>[0],
  identityAccess: OidcProfileIdentityAccess,
) {
  return await sqliteOperations(db, identityAccess).createUserWithIdentity(args)
}

export async function bindInvitedUserWithIdentity(
  db: SqliteIdentityDatabase,
  args: Parameters<ComposedIdentityOperations['bindInvitedUserWithIdentity']>[0],
  identityAccess: OidcProfileIdentityAccess,
): Promise<void> {
  await sqliteOperations(db, identityAccess).bindInvitedUserWithIdentity(args)
}

/** Existing-identity login reconciliation is already provider-neutral: the
 * selected identity-access runtime owns its transaction runner. */
export async function syncPreferredSnapshot(
  args: Parameters<ComposedIdentityOperations['syncPreferredSnapshot']>[0],
  identityAccess: OidcProfileIdentityAccess,
) {
  try {
    return await identityAccess.syncOidcProfile.execute({
      providerId: args.providerId,
      subject: args.subject,
      userId: args.userId,
      displayName: args.displayName,
      gitName: args.gitName,
      email: args.email ?? null,
      emailVerified: args.emailVerified,
      ...(args.expectedSubjectClaim !== undefined
        ? { expectedSubjectClaim: args.expectedSubjectClaim }
        : {}),
      ...(args.expectedUsernameClaim !== undefined
        ? { expectedUsernameClaim: args.expectedUsernameClaim }
        : {}),
      ...(args.expectedGitNameClaim !== undefined
        ? { expectedGitNameClaim: args.expectedGitNameClaim }
        : {}),
      ...(args.expectedEmailClaim !== undefined
        ? { expectedEmailClaim: args.expectedEmailClaim }
        : {}),
    })
  } catch (error) {
    throw identityAccessDomainError(error)
  }
}

export async function deleteIdentity(
  db: SqliteIdentityDatabase,
  identityId: string,
): Promise<void> {
  await sqliteOperations(db).unlinkIdentity(identityId)
}

function identityAccessDomainError(error: unknown): unknown {
  if (!(error instanceof UserAccessError)) return error
  if (error.kind === 'not-found') {
    return new NotFoundError(error.code, error.message, error.details)
  }
  return new ConflictError(error.code, error.message, error.details)
}
