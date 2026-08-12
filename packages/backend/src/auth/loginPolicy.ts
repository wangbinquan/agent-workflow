// RFC-221 — single source of truth for the global login policy and the
// one-way daemon-token → first-human-admin bootstrap handoff.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  AuthLoginPolicy,
  AuthMethodDiscovery,
  CreateBootstrapAdminBody,
} from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { generateSessionToken, hashToken, SESSION_DEFAULT_TTL_MS } from '@/auth/sessionStore'
import type { DbClient } from '@/db/client'
import { authLoginPolicy, oidcProviders, userSessions, users } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { ConflictError, DomainError, ForbiddenError, UnauthorizedError } from '@/util/errors'
import { triggerRevalidation } from '@/ws/revalidationHook'

const GLOBAL_POLICY_ID = 'global'

function materialize(row: typeof authLoginPolicy.$inferSelect): AuthLoginPolicy {
  return {
    passwordLoginEnabled: row.passwordLoginEnabled,
    bootstrapCompletedAt: row.bootstrapCompletedAt,
    updatedAt: row.updatedAt,
  }
}

function missingPolicy(): never {
  throw new DomainError(
    'auth-login-policy-missing',
    'authentication policy singleton is missing',
    500,
  )
}

export function getAuthLoginPolicy(db: DbClient): AuthLoginPolicy {
  const row = db
    .select()
    .from(authLoginPolicy)
    .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
    .get()
  return row === undefined ? missingPolicy() : materialize(row)
}

/**
 * Read the public login method set from one SQLite snapshot. Reading policy
 * and providers in separate awaits can synthesize an impossible empty method
 * set from two individually valid states during a concurrent policy/provider
 * switch.
 */
export function getAuthMethodDiscovery(
  db: DbClient,
  oidcRuntimeAvailable: boolean,
): AuthMethodDiscovery {
  return dbTxSync(db, (tx) => {
    const policy = tx
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .get()
    if (policy === undefined) return missingPolicy()
    if (policy.bootstrapCompletedAt === null) {
      return {
        mode: 'bootstrap',
        providers: [],
        passwordLoginEnabled: false,
        daemonTokenEnabled: true,
      }
    }
    const providers = oidcRuntimeAvailable
      ? tx
          .select({
            slug: oidcProviders.slug,
            displayName: oidcProviders.displayName,
            iconUrl: oidcProviders.iconUrl,
          })
          .from(oidcProviders)
          .where(eq(oidcProviders.enabled, true))
          .all()
      : []
    return {
      mode: 'ready',
      providers,
      passwordLoginEnabled: policy.passwordLoginEnabled,
      daemonTokenEnabled: false,
    }
  })
}

export function isBootstrapRequired(db: DbClient): boolean {
  return getAuthLoginPolicy(db).bootstrapCompletedAt === null
}

export function assertBootstrapComplete(db: DbClient): AuthLoginPolicy {
  const policy = getAuthLoginPolicy(db)
  if (policy.bootstrapCompletedAt === null) {
    throw new ForbiddenError(
      'bootstrap-admin-required',
      'create the first administrator before using this login method',
      { setupPath: '/setup/admin' },
    )
  }
  return policy
}

export function setPasswordLoginEnabled(
  db: DbClient,
  enabled: boolean,
  now: number = Date.now(),
): AuthLoginPolicy {
  return dbTxSync(db, (tx) => {
    const current = tx
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .get()
    if (current === undefined) return missingPolicy()
    if (current.bootstrapCompletedAt === null) {
      throw new ConflictError(
        'bootstrap-admin-required',
        'the first administrator must be created before login policy can change',
      )
    }
    if (!enabled) {
      const anyEnabledProvider =
        tx
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(eq(oidcProviders.enabled, true))
          .limit(1)
          .get() !== undefined
      if (!anyEnabledProvider) {
        throw new ConflictError(
          'password-login-requires-enabled-oidc',
          'at least one enabled identity provider is required before password login can be disabled',
        )
      }
    }
    tx.update(authLoginPolicy)
      .set({ passwordLoginEnabled: enabled, updatedAt: now })
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .run()
    const updated = tx
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .get()
    return updated === undefined ? missingPolicy() : materialize(updated)
  })
}

export interface PreparedBootstrapAdmin extends Omit<CreateBootstrapAdminBody, 'password'> {
  id?: string
  passwordHash: string
}

export function completeBootstrapWithAdmin(
  db: DbClient,
  input: PreparedBootstrapAdmin,
  now: number = Date.now(),
): typeof users.$inferSelect {
  const id = input.id ?? ulid()
  const created = dbTxSync(db, (tx) => {
    const policy = tx
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .get()
    if (policy === undefined) return missingPolicy()
    if (policy.bootstrapCompletedAt !== null) {
      throw new ConflictError(
        'bootstrap-already-complete',
        'another administrator already completed bootstrap',
      )
    }
    if (input.username === SYSTEM_USER_ID) {
      throw new ConflictError('username-reserved', `username '${SYSTEM_USER_ID}' is reserved`)
    }
    const duplicateUsername = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1)
      .get()
    if (duplicateUsername !== undefined) {
      throw new ConflictError('username-taken', `username '${input.username}' already exists`)
    }
    if (input.email !== undefined) {
      const duplicateEmail = tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email.toLowerCase()))
        .limit(1)
        .get()
      if (duplicateEmail !== undefined) {
        throw new ConflictError('email-taken', `email '${input.email}' already exists`)
      }
    }
    tx.insert(users)
      .values({
        id,
        username: input.username,
        email: input.email?.toLowerCase() ?? null,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role: 'admin',
        status: 'active',
        forcePasswordChange: false,
        createdBy: SYSTEM_USER_ID,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        schemaVersion: 1,
      })
      .run()
    tx.update(authLoginPolicy)
      .set({
        passwordLoginEnabled: true,
        bootstrapCompletedAt: now,
        updatedAt: now,
      })
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .run()
    const row = tx.select().from(users).where(eq(users.id, id)).get()
    if (row === undefined) {
      throw new Error('bootstrap administrator insert did not materialize')
    }
    return row
  })
  triggerRevalidation(db, 'bootstrap-completed')
  return created
}

export interface CreatePasswordLoginSessionInput {
  userId: string
  verifiedPasswordHash: string
  userAgent?: string | null
  now?: number
  ttlMs?: number
}

/**
 * Password verification is intentionally performed before this function.
 * This synchronous transaction is the login/policy linearization point: a
 * concurrent policy-off or password/status change can never land a session.
 */
export function createPasswordLoginSession(
  db: DbClient,
  input: CreatePasswordLoginSessionInput,
): {
  token: string
  user: typeof users.$inferSelect
} {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? SESSION_DEFAULT_TTL_MS
  const token = generateSessionToken()
  const sessionId = ulid()
  return dbTxSync(db, (tx) => {
    const policy = tx
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .get()
    if (policy === undefined) return missingPolicy()
    if (policy.bootstrapCompletedAt === null) {
      throw new ForbiddenError(
        'bootstrap-admin-required',
        'create the first administrator before using password login',
      )
    }
    if (!policy.passwordLoginEnabled) {
      throw new ForbiddenError('password-login-disabled', 'username and password login is disabled')
    }
    const user = tx.select().from(users).where(eq(users.id, input.userId)).get()
    if (
      user === undefined ||
      user.status !== 'active' ||
      user.passwordHash === null ||
      user.passwordHash !== input.verifiedPasswordHash
    ) {
      throw new UnauthorizedError('invalid username or password')
    }
    tx.insert(userSessions)
      .values({
        id: sessionId,
        userId: user.id,
        tokenHash: hashToken(token),
        userAgent: input.userAgent ?? null,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + ttlMs,
        revokedAt: null,
      })
      .run()
    tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run()
    return { token, user: { ...user, lastLoginAt: now } }
  })
}
