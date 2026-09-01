import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { AuthLoginPolicy, AuthMethodDiscovery, OidcDefaultRole } from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  authLoginPolicy,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPats,
  userSessions,
  users,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
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

const GLOBAL_POLICY_ID = 'global'

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

function currentPolicy(transaction: DbTxSync): typeof authLoginPolicy.$inferSelect | undefined {
  return transaction
    .select()
    .from(authLoginPolicy)
    .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
    .get()
}

function mutationChanges(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

export class SqliteAuthPersistence implements AuthPersistence {
  constructor(private readonly db: DbClient) {}

  async getLoginPolicy(): Promise<AuthLoginPolicy | null> {
    const row = this.db
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .get()
    return row === undefined ? null : mapPolicy(row)
  }

  async getLoginMethodDiscovery(
    oidcRuntimeAvailable: boolean,
  ): Promise<AuthMethodDiscovery | null> {
    return dbTxSync(this.db, (transaction) => {
      const policy = currentPolicy(transaction)
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
        ? transaction
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
    return dbTxSync(this.db, (transaction) => {
      const current = currentPolicy(transaction)
      if (current === undefined) throw new Error('authentication policy singleton is missing')
      if (current.bootstrapCompletedAt === null) {
        throw new ConflictError(
          'bootstrap-admin-required',
          'the first administrator must be created before login policy can change',
        )
      }
      const passwordLoginEnabled = input.passwordLoginEnabled ?? current.passwordLoginEnabled
      if (!passwordLoginEnabled) {
        const provider = transaction
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
      transaction
        .update(authLoginPolicy)
        .set({
          passwordLoginEnabled,
          oidcDefaultRole: input.oidcDefaultRole ?? current.oidcDefaultRole,
          updatedAt: input.now,
        })
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .run()
      return mapPolicy({
        ...current,
        passwordLoginEnabled,
        oidcDefaultRole: input.oidcDefaultRole ?? current.oidcDefaultRole,
        updatedAt: input.now,
      })
    })
  }

  async completeBootstrap(input: BootstrapAdminRecord): Promise<AuthUserRecord> {
    return dbTxSync(this.db, (transaction) => {
      const policy = currentPolicy(transaction)
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
      if (
        transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, input.username))
          .limit(1)
          .get() !== undefined
      ) {
        throw new ConflictError('username-taken', `username '${input.username}' already exists`)
      }
      if (
        input.email !== null &&
        transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1)
          .get() !== undefined
      ) {
        throw new ConflictError('email-taken', `email '${input.email}' already exists`)
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
      transaction.insert(users).values(user).run()
      transaction
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
      transaction
        .update(authLoginPolicy)
        .set({
          passwordLoginEnabled: true,
          bootstrapCompletedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        .run()
      const created = transaction.select().from(users).where(eq(users.id, input.id)).get()
      if (created === undefined)
        throw new Error('bootstrap administrator insert did not materialize')
      return mapUser(created)
    })
  }

  async createPasswordLoginSession(input: PasswordLoginSessionRecord): Promise<AuthUserRecord> {
    return dbTxSync(this.db, (transaction) => {
      const policy = currentPolicy(transaction)
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
      const user = transaction.select().from(users).where(eq(users.id, input.userId)).get()
      if (
        user === undefined ||
        user.status !== 'active' ||
        user.passwordHash === null ||
        user.passwordHash !== input.verifiedPasswordHash
      ) {
        throw new UnauthorizedError('invalid username or password')
      }
      transaction.insert(userSessions).values(input.session).run()
      transaction
        .update(users)
        .set({ lastLoginAt: input.session.createdAt })
        .where(eq(users.id, user.id))
        .run()
      return mapUser({ ...user, lastLoginAt: input.session.createdAt })
    })
  }

  async findUserByUsername(username: string): Promise<AuthUserRecord | null> {
    const row = this.db.select().from(users).where(eq(users.username, username)).limit(1).get()
    return row === undefined ? null : mapUser(row)
  }

  async findUserById(userId: string): Promise<AuthUserRecord | null> {
    const row = this.db.select().from(users).where(eq(users.id, userId)).limit(1).get()
    return row === undefined ? null : mapUser(row)
  }

  async findInvitedUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const row = this.db.select().from(users).where(eq(users.email, email)).limit(1).get()
    return row?.status === 'invited' ? mapUser(row) : null
  }

  async insertSession(session: AuthSessionRecord): Promise<void> {
    this.db.insert(userSessions).values(session).run()
  }

  async insertLoginSession(session: AuthSessionRecord): Promise<void> {
    dbTxSync(this.db, (transaction) => {
      transaction.insert(userSessions).values(session).run()
      transaction
        .update(users)
        .set({ lastLoginAt: session.createdAt })
        .where(eq(users.id, session.userId))
        .run()
      return undefined
    })
  }

  async resolveSessionByHash(input: {
    readonly hash: string
    readonly now: number
    readonly touch: boolean
    readonly touchIntervalMs: number
  }): Promise<ActiveAuthSession | null> {
    return dbTxSync(this.db, (transaction) => {
      const session = transaction
        .select()
        .from(userSessions)
        .where(eq(userSessions.tokenHash, input.hash))
        .limit(1)
        .get()
      if (session === undefined || session.revokedAt !== null || session.expiresAt < input.now) {
        return null
      }
      const user = transaction.select().from(users).where(eq(users.id, session.userId)).get()
      if (user === undefined || user.status !== 'active') return null
      if (input.touch && input.now - session.lastUsedAt >= input.touchIntervalMs) {
        transaction
          .update(userSessions)
          .set({ lastUsedAt: input.now })
          .where(eq(userSessions.id, session.id))
          .run()
      }
      return { session: mapSession(session), user: mapUser(user) }
    })
  }

  async findSessionOwner(sessionId: string): Promise<string | null> {
    const row = this.db
      .select({ userId: userSessions.userId })
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .get()
    return row?.userId ?? null
  }

  async revokeSession(sessionId: string, now: number): Promise<void> {
    this.db.update(userSessions).set({ revokedAt: now }).where(eq(userSessions.id, sessionId)).run()
  }

  async revokeSessionsForUser(userId: string, now: number): Promise<void> {
    this.db
      .update(userSessions)
      .set({ revokedAt: now })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .run()
  }

  async sweepExpiredSessions(now: number): Promise<number> {
    return mutationChanges(
      this.db.delete(userSessions).where(lt(userSessions.expiresAt, now)).run(),
    )
  }

  async listActiveSessionsForUser(
    userId: string,
    now: number,
  ): Promise<ReadonlyArray<AuthSessionRecord>> {
    return this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, userId))
      .all()
      .filter((row) => row.revokedAt === null && row.expiresAt >= now)
      .map(mapSession)
  }

  async insertPat(pat: AuthPatRecord): Promise<void> {
    this.db.insert(userPats).values(pat).run()
  }

  async resolvePatByHash(input: {
    readonly hash: string
    readonly now: number
    readonly touch: boolean
  }): Promise<ActiveAuthPat | null> {
    return dbTxSync(this.db, (transaction) => {
      const pat = transaction
        .select()
        .from(userPats)
        .where(eq(userPats.tokenHash, input.hash))
        .limit(1)
        .get()
      if (
        pat === undefined ||
        pat.revokedAt !== null ||
        (pat.expiresAt !== null && pat.expiresAt < input.now)
      ) {
        return null
      }
      const user = transaction.select().from(users).where(eq(users.id, pat.userId)).get()
      if (user === undefined || user.status !== 'active') return null
      if (input.touch) {
        transaction
          .update(userPats)
          .set({ lastUsedAt: input.now })
          .where(eq(userPats.id, pat.id))
          .run()
      }
      return { pat: mapPat(pat), user: mapUser(user) }
    })
  }

  async findPatOwner(patId: string): Promise<string | null> {
    const row = this.db
      .select({ userId: userPats.userId })
      .from(userPats)
      .where(eq(userPats.id, patId))
      .get()
    return row?.userId ?? null
  }

  async revokePat(patId: string, now: number): Promise<void> {
    this.db.update(userPats).set({ revokedAt: now }).where(eq(userPats.id, patId)).run()
  }

  async listAllPats(): Promise<ReadonlyArray<AuthPatRecord>> {
    return this.db.select().from(userPats).all().map(mapPat)
  }

  async listPatsForUser(userId: string): Promise<ReadonlyArray<AuthPatRecord>> {
    return this.db.select().from(userPats).where(eq(userPats.userId, userId)).all().map(mapPat)
  }

  async isOidcManagedUser(userId: string): Promise<boolean> {
    return (
      this.db
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .limit(1)
        .get() !== undefined
    )
  }

  async listOidcManagedUserIds(userIds?: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    const wanted = userIds === undefined ? undefined : [...new Set(userIds)]
    if (wanted?.length === 0) return new Set()
    const base = this.db.select({ userId: userIdentities.userId }).from(userIdentities)
    const rows =
      wanted === undefined ? base.all() : base.where(inArray(userIdentities.userId, wanted)).all()
    return new Set(rows.map((row) => row.userId))
  }

  async writeLocalPasswordIfUnmanaged(input: LocalPasswordWrite): Promise<void> {
    dbTxSync(this.db, (transaction) => {
      const user = transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .get()
      if (user === undefined) {
        throw new NotFoundError('user-not-found', `user ${input.userId} not found`)
      }
      const identity = transaction
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
      transaction
        .update(users)
        .set({
          passwordHash: input.passwordHash,
          forcePasswordChange: input.forcePasswordChange,
          ...(input.activate ? { status: 'active' as const } : {}),
          updatedAt: input.updatedAt,
        })
        .where(eq(users.id, input.userId))
        .run()
      return undefined
    })
  }
}
