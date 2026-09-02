import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { AuthLoginPolicy, AuthMethodDiscovery, OidcDefaultRole } from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import {
  authLoginPolicy,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPats,
  userSessions,
  users,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/util/errors'
import type {
  ActiveAuthPat,
  ActiveAuthSession,
  AuthPatRecord,
  AuthPersistence,
  AuthSessionRecord,
  AuthUserRecord,
  BootstrapAdminRecord,
  LocalPasswordWrite,
  PasswordLoginSessionRecord,
} from '../application/authPersistence'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

const GLOBAL_POLICY_ID = 'global'
type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function mapUser(row: typeof users.$inferSelect): AuthUserRecord {
  return {
    ...row,
    role: row.role,
    status: row.status,
  }
}

function mapSession(row: typeof userSessions.$inferSelect): AuthSessionRecord {
  return row
}

function mapPat(row: typeof userPats.$inferSelect): AuthPatRecord {
  return {
    ...row,
    purpose: row.purpose === 'general' ? 'general' : 'mcp_only',
  }
}

function mapPolicy(row: typeof authLoginPolicy.$inferSelect): AuthLoginPolicy {
  return {
    passwordLoginEnabled: row.passwordLoginEnabled,
    oidcDefaultRole: row.oidcDefaultRole,
    bootstrapCompletedAt: row.bootstrapCompletedAt,
    updatedAt: row.updatedAt,
  }
}

function mutationChanges(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

async function serializable<T>(
  db: PostgresqlDatabaseClient,
  body: (transaction: PostgresqlTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (transaction) => {
        await transaction.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(transaction)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

async function currentPolicy(
  transaction: PostgresqlTransaction,
): Promise<typeof authLoginPolicy.$inferSelect | undefined> {
  return await transaction
    .select()
    .from(authLoginPolicy)
    .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
    .limit(1)
    .get()
}

export class PostgresqlAuthPersistence implements AuthPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async getLoginPolicy(): Promise<AuthLoginPolicy | null> {
    const row = await this.db
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .limit(1)
      .get()
    return row === undefined ? null : mapPolicy(row)
  }

  async getLoginMethodDiscovery(
    oidcRuntimeAvailable: boolean,
  ): Promise<AuthMethodDiscovery | null> {
    return await serializable(this.db, async (transaction) => {
      const policy = await currentPolicy(transaction)
      if (policy === undefined) return null
      if (policy.bootstrapCompletedAt === null) {
        return {
          mode: 'bootstrap',
          providers: [],
          passwordLoginEnabled: false,
          daemonTokenEnabled: true,
        }
      }
      const providers = oidcRuntimeAvailable
        ? await transaction
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

  async updateLoginPolicy(input: {
    readonly passwordLoginEnabled?: boolean
    readonly oidcDefaultRole?: OidcDefaultRole
    readonly now: number
  }): Promise<AuthLoginPolicy> {
    return await serializable(this.db, async (transaction) => {
      const current = await currentPolicy(transaction)
      if (current === undefined) throw new Error('authentication policy singleton is missing')
      if (current.bootstrapCompletedAt === null) {
        throw new ConflictError(
          'bootstrap-admin-required',
          'the first administrator must be created before login policy can change',
        )
      }
      const passwordLoginEnabled = input.passwordLoginEnabled ?? current.passwordLoginEnabled
      if (!passwordLoginEnabled) {
        const provider = await transaction
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(eq(oidcProviders.enabled, true))
          .limit(1)
          .get()
        if (provider === undefined) {
          throw new ConflictError(
            'password-login-requires-enabled-oidc',
            'at least one enabled identity provider is required before password login can be disabled',
          )
        }
      }
      const oidcDefaultRole = input.oidcDefaultRole ?? current.oidcDefaultRole
      await transaction
        .update(authLoginPolicy)
        .set({ passwordLoginEnabled, oidcDefaultRole, updatedAt: input.now })
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .run()
      return mapPolicy({
        ...current,
        passwordLoginEnabled,
        oidcDefaultRole,
        updatedAt: input.now,
      })
    })
  }

  async completeBootstrap(input: BootstrapAdminRecord): Promise<AuthUserRecord> {
    try {
      return await serializable(this.db, async (transaction) => {
        const policy = await currentPolicy(transaction)
        if (policy === undefined) throw new Error('authentication policy singleton is missing')
        if (policy.bootstrapCompletedAt !== null) {
          throw new ConflictError(
            'bootstrap-already-complete',
            'another administrator already completed bootstrap',
          )
        }
        if (input.username === SYSTEM_USER_ID) {
          throw new ConflictError('username-reserved', `username '${SYSTEM_USER_ID}' is reserved`)
        }
        const duplicateUsername = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, input.username))
          .limit(1)
          .get()
        if (duplicateUsername !== undefined) {
          throw new ConflictError('username-taken', `username '${input.username}' already exists`)
        }
        if (input.email !== null) {
          const duplicateEmail = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, input.email))
            .limit(1)
            .get()
          if (duplicateEmail !== undefined) {
            throw new ConflictError('email-taken', `email '${input.email}' already exists`)
          }
        }
        const user: typeof users.$inferInsert = {
          id: input.id,
          username: input.username,
          email: input.email,
          displayName: input.displayName,
          gitName: input.displayName,
          passwordHash: input.passwordHash,
          role: 'admin',
          status: 'active',
          forcePasswordChange: false,
          createdBy: SYSTEM_USER_ID,
          createdAt: input.now,
          updatedAt: input.now,
          lastLoginAt: null,
          schemaVersion: 1,
          accessRevision: 0,
        }
        await transaction.insert(users).values(user).run()
        await transaction
          .insert(userAccessAudit)
          .values({
            id: input.auditId,
            targetUserId: input.id,
            actorUserId: SYSTEM_USER_ID,
            actorKind: 'system',
            operationId: input.operationId,
            correlationId: input.operationId,
            beforeRole: 'admin',
            afterRole: 'admin',
            addedPermissionsJson: '[]',
            removedPermissionsJson: '[]',
            accessRevision: 0,
            createdAt: input.now,
          })
          .run()
        await transaction
          .update(authLoginPolicy)
          .set({
            passwordLoginEnabled: true,
            bootstrapCompletedAt: input.now,
            updatedAt: input.now,
          })
          .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
          .run()
        const created = await transaction
          .select()
          .from(users)
          .where(eq(users.id, input.id))
          .limit(1)
          .get()
        if (created === undefined) {
          throw new Error('bootstrap administrator insert did not materialize')
        }
        return mapUser(created)
      })
    } catch (error) {
      throw mapBootstrapConstraint(error, input)
    }
  }

  async createPasswordLoginSession(input: PasswordLoginSessionRecord): Promise<AuthUserRecord> {
    return await serializable(this.db, async (transaction) => {
      const policy = await currentPolicy(transaction)
      if (policy === undefined) throw new Error('authentication policy singleton is missing')
      if (policy.bootstrapCompletedAt === null) {
        throw new ForbiddenError(
          'bootstrap-admin-required',
          'create the first administrator before using password login',
        )
      }
      if (!policy.passwordLoginEnabled) {
        throw new ForbiddenError(
          'password-login-disabled',
          'username and password login is disabled',
        )
      }
      const user = await transaction
        .select()
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .get()
      if (
        user === undefined ||
        user.status !== 'active' ||
        user.passwordHash === null ||
        user.passwordHash !== input.verifiedPasswordHash
      ) {
        throw new UnauthorizedError('invalid username or password')
      }
      await transaction.insert(userSessions).values(input.session).run()
      await transaction
        .update(users)
        .set({ lastLoginAt: input.session.createdAt })
        .where(eq(users.id, user.id))
        .run()
      return mapUser({ ...user, lastLoginAt: input.session.createdAt })
    })
  }

  async findUserByUsername(username: string): Promise<AuthUserRecord | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1)
      .get()
    return row === undefined ? null : mapUser(row)
  }

  async findUserById(userId: string): Promise<AuthUserRecord | null> {
    const row = await this.db.select().from(users).where(eq(users.id, userId)).limit(1).get()
    return row === undefined ? null : mapUser(row)
  }

  async findInvitedUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const row = await this.db.select().from(users).where(eq(users.email, email)).limit(1).get()
    return row?.status === 'invited' ? mapUser(row) : null
  }

  async insertSession(session: AuthSessionRecord): Promise<void> {
    await this.db.insert(userSessions).values(session).run()
  }

  async insertLoginSession(session: AuthSessionRecord): Promise<void> {
    await serializable(this.db, async (transaction) => {
      await transaction.insert(userSessions).values(session).run()
      await transaction
        .update(users)
        .set({ lastLoginAt: session.createdAt })
        .where(eq(users.id, session.userId))
        .run()
    })
  }

  async resolveSessionByHash(input: {
    readonly hash: string
    readonly now: number
    readonly touch: boolean
    readonly touchIntervalMs: number
  }): Promise<ActiveAuthSession | null> {
    return await serializable(this.db, async (transaction) => {
      const rows = await transaction
        .select({ session: userSessions, user: users })
        .from(userSessions)
        .innerJoin(users, eq(users.id, userSessions.userId))
        .where(eq(userSessions.tokenHash, input.hash))
        .limit(1)
        .all()
      const row = rows[0]
      if (
        row === undefined ||
        row.session.revokedAt !== null ||
        row.session.expiresAt < input.now ||
        row.user.status !== 'active'
      ) {
        return null
      }
      if (input.touch && input.now - row.session.lastUsedAt >= input.touchIntervalMs) {
        await transaction
          .update(userSessions)
          .set({ lastUsedAt: input.now })
          .where(and(eq(userSessions.id, row.session.id), isNull(userSessions.revokedAt)))
          .run()
      }
      return { session: mapSession(row.session), user: mapUser(row.user) }
    })
  }

  async findSessionOwner(sessionId: string): Promise<string | null> {
    const row = await this.db
      .select({ userId: userSessions.userId })
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .limit(1)
      .get()
    return row?.userId ?? null
  }

  async revokeSession(sessionId: string, now: number): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ revokedAt: now })
      .where(eq(userSessions.id, sessionId))
      .run()
  }

  async revokeSessionsForUser(userId: string, now: number): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ revokedAt: now })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .run()
  }

  async sweepExpiredSessions(now: number): Promise<number> {
    return mutationChanges(
      await this.db.delete(userSessions).where(lt(userSessions.expiresAt, now)).run(),
    )
  }

  async listActiveSessionsForUser(
    userId: string,
    now: number,
  ): Promise<ReadonlyArray<AuthSessionRecord>> {
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, userId))
      .all()
    return rows.filter((row) => row.revokedAt === null && row.expiresAt >= now).map(mapSession)
  }

  async insertPat(pat: AuthPatRecord): Promise<void> {
    await this.db.insert(userPats).values(pat).run()
  }

  async resolvePatByHash(input: {
    readonly hash: string
    readonly now: number
    readonly touch: boolean
  }): Promise<ActiveAuthPat | null> {
    return await serializable(this.db, async (transaction) => {
      const rows = await transaction
        .select({ pat: userPats, user: users })
        .from(userPats)
        .innerJoin(users, eq(users.id, userPats.userId))
        .where(eq(userPats.tokenHash, input.hash))
        .limit(1)
        .all()
      const row = rows[0]
      if (
        row === undefined ||
        row.pat.revokedAt !== null ||
        (row.pat.expiresAt !== null && row.pat.expiresAt < input.now) ||
        row.user.status !== 'active'
      ) {
        return null
      }
      if (input.touch) {
        await transaction
          .update(userPats)
          .set({ lastUsedAt: input.now })
          .where(and(eq(userPats.id, row.pat.id), isNull(userPats.revokedAt)))
          .run()
      }
      return { pat: mapPat(row.pat), user: mapUser(row.user) }
    })
  }

  async findPatOwner(patId: string): Promise<string | null> {
    const row = await this.db
      .select({ userId: userPats.userId })
      .from(userPats)
      .where(eq(userPats.id, patId))
      .limit(1)
      .get()
    return row?.userId ?? null
  }

  async revokePat(patId: string, now: number): Promise<void> {
    await this.db.update(userPats).set({ revokedAt: now }).where(eq(userPats.id, patId)).run()
  }

  async listAllPats(): Promise<ReadonlyArray<AuthPatRecord>> {
    return (await this.db.select().from(userPats).all()).map(mapPat)
  }

  async listPatsForUser(userId: string): Promise<ReadonlyArray<AuthPatRecord>> {
    return (await this.db.select().from(userPats).where(eq(userPats.userId, userId)).all()).map(
      mapPat,
    )
  }

  async isOidcManagedUser(userId: string): Promise<boolean> {
    const row = await this.db
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .limit(1)
      .get()
    return row !== undefined
  }

  async listOidcManagedUserIds(userIds?: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    const wanted = userIds === undefined ? undefined : [...new Set(userIds)]
    if (wanted?.length === 0) return new Set()
    const base = this.db.select({ userId: userIdentities.userId }).from(userIdentities)
    const rows =
      wanted === undefined
        ? await base.all()
        : await base.where(inArray(userIdentities.userId, wanted)).all()
    return new Set(rows.map((row) => row.userId))
  }

  async writeLocalPasswordIfUnmanaged(input: LocalPasswordWrite): Promise<void> {
    await serializable(this.db, async (transaction) => {
      const user = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .get()
      if (user === undefined) {
        throw new NotFoundError('user-not-found', `user ${input.userId} not found`)
      }
      const identity = await transaction
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(eq(userIdentities.userId, input.userId))
        .limit(1)
        .get()
      if (identity !== undefined) {
        throw new ForbiddenError(
          'oidc-password-managed',
          'password is managed by the linked identity provider',
        )
      }
      await transaction
        .update(users)
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
}

function mapBootstrapConstraint(
  error: unknown,
  input: Pick<BootstrapAdminRecord, 'username' | 'email'>,
): unknown {
  if (error instanceof ConflictError) return error
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as {
      readonly code?: unknown
      readonly constraint?: unknown
      readonly message?: unknown
      readonly cause?: unknown
    }
    if (record.code === '23505') {
      const constraint = typeof record.constraint === 'string' ? record.constraint : ''
      const message = typeof record.message === 'string' ? record.message : ''
      if (constraint === 'users_username_unique' || /users_username_unique/i.test(message)) {
        return new ConflictError('username-taken', `username '${input.username}' already exists`)
      }
      if (constraint === 'users_email_unique' || /users_email_unique/i.test(message)) {
        return new ConflictError('email-taken', `email '${input.email ?? ''}' already exists`)
      }
    }
    current = record.cause
  }
  return error
}
