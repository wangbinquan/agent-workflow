// RFC-221 — single source of truth for the global login policy and the
// one-way daemon-token → first-human-admin bootstrap handoff.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  AuthLoginPolicy,
  AuthMethodDiscovery,
  CreateBootstrapAdminBody,
  OidcDefaultRole,
  UpdateAuthLoginPolicyBody,
} from '@agent-workflow/shared'
import { generateSessionToken, hashToken, SESSION_DEFAULT_TTL_MS } from './legacySqliteSessionStore'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { authLoginPolicy, oidcProviders, userSessions, users } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, DomainError, ForbiddenError, UnauthorizedError } from '@/util/errors'

const GLOBAL_POLICY_ID = 'global'

function materialize(row: typeof authLoginPolicy.$inferSelect): AuthLoginPolicy {
  return {
    passwordLoginEnabled: row.passwordLoginEnabled,
    oidcDefaultRole: row.oidcDefaultRole,
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
export async function getAuthMethodDiscovery(
  db: DbClient,
  oidcRuntimeAvailable: boolean,
): Promise<AuthMethodDiscovery> {
  return await databaseSessionFor(db).transaction(async (tx) => {
    const policy = (
      await tx
        .select()
        .from(authLoginPolicy)
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .limit(1)
    )[0]
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
      ? await tx
          .select({
            slug: oidcProviders.slug,
            displayName: oidcProviders.displayName,
            iconUrl: oidcProviders.iconUrl,
          })
          .from(oidcProviders)
          .where(eq(oidcProviders.enabled, true))
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

export async function updateAuthLoginPolicy(
  // RFC-359：函数体早已是中立的（`databaseSessionFor(db).transaction` + await 的 select），
  // 只有入参类型还钉在 SQLite 上——那把这三个夹具挡在了双引擎用例之外。同文件里真正同步的
  // 那几个（`getAuthLoginPolicy` / `isBootstrapRequired` 用 `.get()`）没动。
  db: ProviderNeutralDatabase,
  patch: UpdateAuthLoginPolicyBody,
  now: number = Date.now(),
): Promise<AuthLoginPolicy> {
  return await databaseSessionFor(db).transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(authLoginPolicy)
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .limit(1)
    )[0]
    if (current === undefined) return missingPolicy()
    if (current.bootstrapCompletedAt === null) {
      throw new ConflictError(
        'bootstrap-admin-required',
        'the first administrator must be created before login policy can change',
      )
    }
    const passwordLoginEnabled = patch.passwordLoginEnabled ?? current.passwordLoginEnabled
    if (!passwordLoginEnabled) {
      const anyEnabledProvider =
        (
          await tx
            .select({ id: oidcProviders.id })
            .from(oidcProviders)
            .where(eq(oidcProviders.enabled, true))
            .limit(1)
        )[0] !== undefined
      if (!anyEnabledProvider) {
        throw new ConflictError(
          'password-login-requires-enabled-oidc',
          'at least one enabled identity provider is required before password login can be disabled',
        )
      }
    }
    await tx
      .update(authLoginPolicy)
      .set({
        passwordLoginEnabled,
        oidcDefaultRole: patch.oidcDefaultRole ?? current.oidcDefaultRole,
        updatedAt: now,
      })
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
    const updated = (
      await tx
        .select()
        .from(authLoginPolicy)
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .limit(1)
    )[0]
    return updated === undefined ? missingPolicy() : materialize(updated)
  })
}

export async function setPasswordLoginEnabled(
  db: ProviderNeutralDatabase,
  enabled: boolean,
  now: number = Date.now(),
): Promise<AuthLoginPolicy> {
  return await updateAuthLoginPolicy(db, { passwordLoginEnabled: enabled }, now)
}

export async function setOidcDefaultRole(
  db: ProviderNeutralDatabase,
  role: OidcDefaultRole,
  now: number = Date.now(),
): Promise<AuthLoginPolicy> {
  return await updateAuthLoginPolicy(db, { oidcDefaultRole: role }, now)
}

export interface PreparedBootstrapAdmin extends Omit<CreateBootstrapAdminBody, 'password'> {
  id?: string
  passwordHash: string
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
 * This transaction is the login/policy linearization point: a concurrent
 * policy-off or password/status change can never land a session.
 * RFC-359：从 bun:sqlite 独有的同步事务面搬到中立事务原语，边界一格未变。
 */
export async function createPasswordLoginSession(
  db: DbClient,
  input: CreatePasswordLoginSessionInput,
): Promise<{
  token: string
  user: typeof users.$inferSelect
}> {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? SESSION_DEFAULT_TTL_MS
  const token = generateSessionToken()
  const sessionId = ulid()
  return await databaseSessionFor(db).transaction(async (tx) => {
    const policy = (
      await tx
        .select()
        .from(authLoginPolicy)
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .limit(1)
    )[0]
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
    const user = (await tx.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]
    if (
      user === undefined ||
      user.status !== 'active' ||
      user.passwordHash === null ||
      user.passwordHash !== input.verifiedPasswordHash
    ) {
      throw new UnauthorizedError('invalid username or password')
    }
    await tx.insert(userSessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash: hashToken(token),
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + ttlMs,
      revokedAt: null,
    })
    await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id))
    return { token, user: { ...user, lastLoginAt: now } }
  })
}
