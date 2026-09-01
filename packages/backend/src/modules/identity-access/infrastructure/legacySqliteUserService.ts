// RFC-036/RFC-349 — explicit SQLite compatibility fixture for legacy tests and
// setup helpers. Production callers consume IdentityAccessRuntime operations;
// provider selection never reaches this adapter.

import { inArray, and, eq, like, ne, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  type GitCommitIdentity,
  type CreateUserBody,
  type PatchUserBody,
  type Role,
  type UserPublic,
} from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import { createSqliteAuthRuntime } from '@/auth/composition'
import { hashPassword } from '@/auth/passwords'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

export type UserRow = typeof users.$inferSelect

async function createLegacyIdentityAccessRuntime(db: DbClient) {
  // Lazy solely to keep the compatibility namespace out of the production
  // composition module's initialization cycle. The module is cached after the
  // first test/setup call.
  const { createIdentityAccessRuntime } = await import('../composition')
  return createIdentityAccessRuntime({ db })
}

/** Legacy test/runtime-neutral fallback. Daemon task launch injects the
 * bootstrap-owned query directly; callers without a runtime are test/setup
 * fixtures that receive a short-lived explicit instance. */
export async function getUserGitCommitIdentity(
  db: DbClient,
  userId: string,
): Promise<GitCommitIdentity> {
  const runtime = await createLegacyIdentityAccessRuntime(db)
  try {
    return await runtime.getUserGitCommitIdentity.execute(userId)
  } finally {
    runtime.shutdown()
  }
}

export async function countNonSystemUsers(db: DbClient): Promise<number> {
  const rows = await db.select().from(users).where(ne(users.id, SYSTEM_USER_ID))
  return rows.length
}

export async function findById(db: DbClient, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return rows[0] ?? null
}

export async function findByUsername(db: DbClient, username: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1)
  return rows[0] ?? null
}

export interface CreateUserInput extends Omit<CreateUserBody, 'additionalPermissions'> {
  /** RFC-305 compatibility: legacy/internal creators default to no grants. */
  additionalPermissions?: CreateUserBody['additionalPermissions']
  createdBy?: string | null
  now?: number
  /**
   * RFC-036 override. Without it: password present → active, password
   * absent → invited (admin-creates-an-invited-user flow). OIDC auto-
   * provisioning passes `status='active'` because the IdP already
   * verified the identity; password stays null forever.
   */
  status?: 'active' | 'disabled' | 'invited'
}

export async function createUser(db: DbClient, input: CreateUserInput): Promise<UserRow> {
  const now = input.now ?? Date.now()
  const passwordHash = input.password ? await hashPassword(input.password) : null
  const status = input.status ?? (passwordHash ? 'active' : 'invited')
  const id = ulid()
  // Legacy test/setup fixture. Production user commands receive the daemon or
  // CLI bootstrap runtime through composeIdentityUserOperations.
  const module = await createLegacyIdentityAccessRuntime(db)
  try {
    const localOperator = await module.localOperator.forUser(input.createdBy ?? SYSTEM_USER_ID)
    if (localOperator === null) {
      throw new ForbiddenError('user-access-actor-inactive', 'user access actor is not active')
    }
    const context = localOperator.commandContext(now)
    try {
      await module.createManagedUser.execute(context, {
        id,
        username: input.username,
        email: input.email ?? null,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        status,
        forcePasswordChange: false,
        createdBy: input.createdBy ?? null,
        schemaVersion: 1,
        additionalPermissions: input.additionalPermissions ?? [],
      })
    } catch (error) {
      rethrowUserAccessError(error)
    }
    return (await findById(db, id))!
  } finally {
    module.shutdown()
  }
}

export interface ResetPasswordInput {
  newPassword: string
  force?: boolean
  now?: number
}

export async function resetPassword(
  db: DbClient,
  id: string,
  input: ResetPasswordInput,
  auth: AuthRuntime = createSqliteAuthRuntime({ db }),
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot reset password for __system__')
  }
  const passwordHash = await hashPassword(input.newPassword)
  const now = input.now ?? Date.now()
  await auth.writeLocalPasswordIfUnmanaged({
    userId: id,
    passwordHash,
    forcePasswordChange: input.force ?? false,
    activate: true,
    updatedAt: now,
  })
  await auth.revokeAllSessionsForUser(id, now)
}

export async function disableUser(
  db: DbClient,
  id: string,
  now: number = Date.now(),
  actorId?: string,
  auth: AuthRuntime = createSqliteAuthRuntime({ db }),
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot disable __system__')
  }
  await patchUser(db, id, { status: 'disabled' }, now, actorId, auth)
}

/**
 * Re-activate a disabled (or invited) account — the inverse of disableUser.
 * The web UI re-enables via PATCH {status:'active'} (patchUser); this focused
 * setter backs the CLI `enable` break-glass subcommand and any programmatic
 * caller. No last-admin / self guards: re-enabling can only ADD an active
 * admin, and a disabled user can't be logged in to re-enable themselves.
 */
export async function enableUser(
  db: DbClient,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot modify __system__')
  }
  await patchUser(db, id, { status: 'active' }, now)
}

export async function patchUser(
  db: DbClient,
  id: string,
  patch: PatchUserBody,
  now: number = Date.now(),
  actorId?: string,
  auth: AuthRuntime = createSqliteAuthRuntime({ db }),
): Promise<UserRow> {
  // Legacy test/setup fixture; production routes use their injected runtime.
  const module = await createLegacyIdentityAccessRuntime(db)
  try {
    const localOperator =
      actorId === undefined
        ? await module.localOperator.forUser(SYSTEM_USER_ID)
        : await module.localOperator.forLegacyHttpUser(actorId)
    if (localOperator === null) {
      throw new ForbiddenError('user-access-actor-inactive', 'user access actor is not active')
    }
    const context = localOperator.commandContext(now)
    let result
    try {
      result = await module.updateUserAccess.execute(context, {
        targetUserId: id,
        displayName: patch.displayName,
        email: patch.email,
        status: patch.status,
        forcePasswordChange: patch.forcePasswordChange,
        access: patch.access,
        legacyRole: patch.role,
      })
    } catch (error) {
      rethrowUserAccessError(error)
    }
    if (result.becameDisabled) await auth.revokeAllSessionsForUser(id, now)
    return (await findById(db, id))!
  } finally {
    module.shutdown()
  }
}

function rethrowUserAccessError(error: unknown): never {
  if (!(error instanceof UserAccessError)) throw error
  switch (error.kind) {
    case 'conflict':
      throw new ConflictError(error.code, error.message, error.details)
    case 'forbidden':
      throw new ForbiddenError(error.code, error.message, error.details)
    case 'not-found':
      throw new NotFoundError(error.code, error.message, error.details)
    case 'validation':
      throw new ValidationError(error.code, error.message, error.details)
  }
}

export interface SearchInput {
  q?: string
  limit?: number
  excludeIds?: string[]
  /** Apply before the result limit so an active-only picker cannot be starved by disabled rows. */
  status?: UserPublic['status']
}

/**
 * RFC-099 — resolve a batch of user ids to their PUBLIC projection (id /
 * username / displayName / role / status). Unknown ids and the __system__
 * sentinel drop out silently. Disabled users ARE returned — historic
 * attribution chips must keep rendering after an account is disabled.
 */
export async function lookupUsersPublic(db: DbClient, ids: string[]): Promise<UserPublic[]> {
  const wanted = [...new Set(ids)].filter((id) => id !== SYSTEM_USER_ID)
  if (wanted.length === 0) return []
  const rows = await db.select().from(users).where(inArray(users.id, wanted))
  return rows.map(
    (r): UserPublic => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName,
      role: r.role as Role,
      status: r.status as UserPublic['status'],
    }),
  )
}

export async function searchUsersPublic(db: DbClient, input: SearchInput): Promise<UserPublic[]> {
  const q = (input.q ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const rows = q
    ? await db
        .select()
        .from(users)
        .where(
          and(
            ne(users.id, SYSTEM_USER_ID),
            // Prefix match on both username and display_name per design §5.4.
            or(like(users.username, `${q}%`), like(users.displayName, `${q}%`)),
          ),
        )
    : await db.select().from(users).where(ne(users.id, SYSTEM_USER_ID))
  const excluded = new Set(input.excludeIds ?? [])
  return rows
    .filter((r) => !excluded.has(r.id))
    .filter((r) => input.status === undefined || r.status === input.status)
    .filter((r) => input.status !== undefined || r.status !== 'disabled' || excluded.size === 0)
    .slice(0, limit)
    .map(
      (r): UserPublic => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        role: r.role as Role,
        status: r.status as 'active' | 'disabled' | 'invited',
      }),
    )
}

export async function listAllUsers(db: DbClient): Promise<UserRow[]> {
  return db.select().from(users)
}

/** Type-only shape exported to the lazy legacy facade in composition. */
export interface LegacySqliteUserService {
  readonly countNonSystemUsers: typeof countNonSystemUsers
  readonly createUser: typeof createUser
  readonly disableUser: typeof disableUser
  readonly enableUser: typeof enableUser
  readonly findById: typeof findById
  readonly findByUsername: typeof findByUsername
  readonly getUserGitCommitIdentity: typeof getUserGitCommitIdentity
  readonly listAllUsers: typeof listAllUsers
  readonly lookupUsersPublic: typeof lookupUsersPublic
  readonly patchUser: typeof patchUser
  readonly resetPassword: typeof resetPassword
  readonly searchUsersPublic: typeof searchUsersPublic
}
