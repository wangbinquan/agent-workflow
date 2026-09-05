// RFC-359 W4-D9 —— 认证持久化（登录策略 / bootstrap 首管理员 / 会话 / PAT / 本地口令）：一份实现，两个 provider 共用。
//
// 事务形态按统一原语与能力矩阵取最优，而不是照搬 RFC-349 PG 版「所有多行操作都 SERIALIZABLE」：
//   · 读—改—写（改策略、bootstrap、口令登录、写本地口令）：`session.transaction` + `lockAggregateRoot` 锁住
//     策略单例行 / 用户行（PG 渲染 FOR UPDATE，SQLite 独占事务下 no-op）——并发的「策略关闭 vs 登录」在两边
//     都串行化，这是 RFC-221 要的登录 / 策略线性化点；
//   · 登录方法发现是只读快照（策略 + provider 两条 select 不能拼出一个不可能的空集合）：`session.serializable`
//     ——PG 上只读 SERIALIZABLE 没有写冲突，SQLite 上就是 BEGIN IMMEDIATE；
//   · 会话 / PAT 解析是每个请求都走的热路径：一条 join 读 + 一条带 `revoked_at is null` 谓词的单语句 touch，
//     不开事务（PG 上不再每个请求一笔 SERIALIZABLE；SQLite 上不再抢 writer 租约做只读解析）。touch 本身是
//     best-effort 的活动投影（RFC-349 T10），不是凭据有效性围栏；
//   · bootstrap 的用户名 / 邮箱竞争交给库的唯一约束，经能力矩阵 `uniqueViolationTarget` 映射回
//     `username-taken` / `email-taken`（两个引擎同一条正则）。

import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { AuthLoginPolicy, AuthMethodDiscovery, OidcDefaultRole } from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  authLoginPolicy,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPats,
  userSessions,
  users,
} from '@/db/schema'
import {
  affectedRows,
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
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
  return { ...row, role: row.role, status: row.status }
}

function mapSession(row: typeof userSessions.$inferSelect): AuthSessionRecord {
  return row
}

function mapPat(row: typeof userPats.$inferSelect): AuthPatRecord {
  return { ...row, purpose: row.purpose === 'general' ? 'general' : 'mcp_only' }
}

function mapPolicy(row: typeof authLoginPolicy.$inferSelect): AuthLoginPolicy {
  return {
    passwordLoginEnabled: row.passwordLoginEnabled,
    oidcDefaultRole: row.oidcDefaultRole,
    bootstrapCompletedAt: row.bootstrapCompletedAt,
    updatedAt: row.updatedAt,
  }
}

async function currentPolicy(
  handle: ProviderNeutralDatabase,
): Promise<typeof authLoginPolicy.$inferSelect | undefined> {
  return (
    await handle
      .select()
      .from(authLoginPolicy)
      .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
      .limit(1)
  )[0]
}

async function lockPolicy(engine: EngineCapabilities, tx: DatabaseTransaction): Promise<void> {
  await engine.lockAggregateRoot(tx, authLoginPolicy, authLoginPolicy.id, GLOBAL_POLICY_ID)
}

/** bootstrap 的用户名 / 邮箱唯一冲突 → 闭合的 conflict 合同（两个引擎同一条正则，见能力矩阵 uniqueViolationTarget）。 */
export function mapBootstrapConstraint(
  engine: EngineCapabilities,
  error: unknown,
  input: Pick<BootstrapAdminRecord, 'username' | 'email'>,
): unknown {
  if (error instanceof ConflictError) return error
  const target = engine.uniqueViolationTarget(error)
  if (target === undefined) return error
  if (/users[._]username/i.test(target)) {
    return new ConflictError('username-taken', `username '${input.username}' already exists`)
  }
  if (/users[._]email/i.test(target)) {
    return new ConflictError('email-taken', `email '${input.email ?? ''}' already exists`)
  }
  return error
}

export function createAuthPersistence(db: ProviderNeutralDatabase): AuthPersistence {
  const session = databaseSessionFor(db)
  const engine = session.engine
  return {
    async getLoginPolicy() {
      const row = await currentPolicy(db)
      return row === undefined ? null : mapPolicy(row)
    },

    async getLoginMethodDiscovery(oidcRuntimeAvailable) {
      return await session.serializable(async (tx) => {
        const policy = await currentPolicy(tx)
        if (policy === undefined) return null
        if (policy.bootstrapCompletedAt === null) {
          return {
            mode: 'bootstrap' as const,
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
          mode: 'ready' as const,
          providers,
          passwordLoginEnabled: policy.passwordLoginEnabled,
          daemonTokenEnabled: false,
        } satisfies AuthMethodDiscovery
      })
    },

    async updateLoginPolicy(input: {
      readonly passwordLoginEnabled?: boolean
      readonly oidcDefaultRole?: OidcDefaultRole
      readonly now: number
    }) {
      return await session.transaction(async (tx) => {
        await lockPolicy(engine, tx)
        const current = await currentPolicy(tx)
        if (current === undefined) throw new Error('authentication policy singleton is missing')
        if (current.bootstrapCompletedAt === null) {
          throw new ConflictError(
            'bootstrap-admin-required',
            'the first administrator must be created before login policy can change',
          )
        }
        const passwordLoginEnabled = input.passwordLoginEnabled ?? current.passwordLoginEnabled
        if (!passwordLoginEnabled) {
          const provider = (
            await tx
              .select({ id: oidcProviders.id })
              .from(oidcProviders)
              .where(eq(oidcProviders.enabled, true))
              .limit(1)
          )[0]
          if (provider === undefined) {
            throw new ConflictError(
              'password-login-requires-enabled-oidc',
              'at least one enabled identity provider is required before password login can be disabled',
            )
          }
        }
        const oidcDefaultRole = input.oidcDefaultRole ?? current.oidcDefaultRole
        await tx
          .update(authLoginPolicy)
          .set({ passwordLoginEnabled, oidcDefaultRole, updatedAt: input.now })
          .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
        return mapPolicy({
          ...current,
          passwordLoginEnabled,
          oidcDefaultRole,
          updatedAt: input.now,
        })
      })
    },

    async completeBootstrap(input) {
      try {
        return await session.transaction(async (tx) => {
          await lockPolicy(engine, tx)
          const policy = await currentPolicy(tx)
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
          const duplicateUsername = (
            await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.username, input.username))
              .limit(1)
          )[0]
          if (duplicateUsername !== undefined) {
            throw new ConflictError('username-taken', `username '${input.username}' already exists`)
          }
          if (input.email !== null) {
            const duplicateEmail = (
              await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, input.email))
                .limit(1)
            )[0]
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
          await tx.insert(users).values(user)
          // admin 的 baseline 是动态全量，没有默认附加授权（RFC-312）；审计行由这里直落，identity-access 不参与。
          await tx.insert(userAccessAudit).values({
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
          await tx
            .update(authLoginPolicy)
            .set({
              passwordLoginEnabled: true,
              bootstrapCompletedAt: input.now,
              updatedAt: input.now,
            })
            .where(eq(authLoginPolicy.id, GLOBAL_POLICY_ID))
          const created = (await tx.select().from(users).where(eq(users.id, input.id)).limit(1))[0]
          if (created === undefined) {
            throw new Error('bootstrap administrator insert did not materialize')
          }
          return mapUser(created)
        })
      } catch (error) {
        throw mapBootstrapConstraint(engine, error, input)
      }
    },

    async createPasswordLoginSession(input) {
      return await session.transaction(async (tx) => {
        await lockPolicy(engine, tx)
        const policy = await currentPolicy(tx)
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
        await engine.lockAggregateRoot(tx, users, users.id, input.userId)
        const user = (await tx.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]
        if (
          user === undefined ||
          user.status !== 'active' ||
          user.passwordHash === null ||
          user.passwordHash !== input.verifiedPasswordHash
        ) {
          throw new UnauthorizedError('invalid username or password')
        }
        await tx.insert(userSessions).values(input.session)
        await tx
          .update(users)
          .set({ lastLoginAt: input.session.createdAt })
          .where(eq(users.id, user.id))
        return mapUser({ ...user, lastLoginAt: input.session.createdAt })
      })
    },

    async findUserByUsername(username) {
      const row = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0]
      return row === undefined ? null : mapUser(row)
    },

    async findUserById(userId) {
      const row = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
      return row === undefined ? null : mapUser(row)
    },

    async findInvitedUserByEmail(email) {
      const row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
      return row?.status === 'invited' ? mapUser(row) : null
    },

    async insertSession(sessionRecord) {
      await db.insert(userSessions).values(sessionRecord)
    },

    async insertLoginSession(sessionRecord) {
      await session.transaction(async (tx) => {
        await tx.insert(userSessions).values(sessionRecord)
        await tx
          .update(users)
          .set({ lastLoginAt: sessionRecord.createdAt })
          .where(eq(users.id, sessionRecord.userId))
      })
    },

    async resolveSessionByHash(input) {
      const row = (
        await db
          .select({ session: userSessions, user: users })
          .from(userSessions)
          .innerJoin(users, eq(users.id, userSessions.userId))
          .where(eq(userSessions.tokenHash, input.hash))
          .limit(1)
      )[0]
      if (
        row === undefined ||
        row.session.revokedAt !== null ||
        row.session.expiresAt < input.now ||
        row.user.status !== 'active'
      ) {
        return null
      }
      if (input.touch && input.now - row.session.lastUsedAt >= input.touchIntervalMs) {
        await db
          .update(userSessions)
          .set({ lastUsedAt: input.now })
          .where(and(eq(userSessions.id, row.session.id), isNull(userSessions.revokedAt)))
      }
      return {
        session: mapSession(row.session),
        user: mapUser(row.user),
      } satisfies ActiveAuthSession
    },

    async findSessionOwner(sessionId) {
      const row = (
        await db
          .select({ userId: userSessions.userId })
          .from(userSessions)
          .where(eq(userSessions.id, sessionId))
          .limit(1)
      )[0]
      return row?.userId ?? null
    },

    async revokeSession(sessionId, now) {
      await db.update(userSessions).set({ revokedAt: now }).where(eq(userSessions.id, sessionId))
    },

    async revokeSessionsForUser(userId, now) {
      await db
        .update(userSessions)
        .set({ revokedAt: now })
        .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    },

    async sweepExpiredSessions(now) {
      return affectedRows(await db.delete(userSessions).where(lt(userSessions.expiresAt, now)))
    },

    async listActiveSessionsForUser(userId, now) {
      const rows = await db.select().from(userSessions).where(eq(userSessions.userId, userId))
      return rows.filter((row) => row.revokedAt === null && row.expiresAt >= now).map(mapSession)
    },

    async insertPat(pat) {
      await db.insert(userPats).values(pat)
    },

    async resolvePatByHash(input) {
      const row = (
        await db
          .select({ pat: userPats, user: users })
          .from(userPats)
          .innerJoin(users, eq(users.id, userPats.userId))
          .where(eq(userPats.tokenHash, input.hash))
          .limit(1)
      )[0]
      if (
        row === undefined ||
        row.pat.revokedAt !== null ||
        (row.pat.expiresAt !== null && row.pat.expiresAt < input.now) ||
        row.user.status !== 'active'
      ) {
        return null
      }
      if (input.touch) {
        await db
          .update(userPats)
          .set({ lastUsedAt: input.now })
          .where(and(eq(userPats.id, row.pat.id), isNull(userPats.revokedAt)))
      }
      return { pat: mapPat(row.pat), user: mapUser(row.user) } satisfies ActiveAuthPat
    },

    async findPatOwner(patId) {
      const row = (
        await db
          .select({ userId: userPats.userId })
          .from(userPats)
          .where(eq(userPats.id, patId))
          .limit(1)
      )[0]
      return row?.userId ?? null
    },

    async revokePat(patId, now) {
      await db.update(userPats).set({ revokedAt: now }).where(eq(userPats.id, patId))
    },

    async listAllPats() {
      return (await db.select().from(userPats)).map(mapPat)
    },

    async listPatsForUser(userId) {
      return (await db.select().from(userPats).where(eq(userPats.userId, userId))).map(mapPat)
    },

    async isOidcManagedUser(userId) {
      const row = (
        await db
          .select({ id: userIdentities.id })
          .from(userIdentities)
          .where(eq(userIdentities.userId, userId))
          .limit(1)
      )[0]
      return row !== undefined
    },

    async listOidcManagedUserIds(userIds) {
      const wanted = userIds === undefined ? undefined : [...new Set(userIds)]
      if (wanted?.length === 0) return new Set()
      const base = db.select({ userId: userIdentities.userId }).from(userIdentities)
      const rows =
        wanted === undefined ? await base : await base.where(inArray(userIdentities.userId, wanted))
      return new Set(rows.map((row) => row.userId))
    },

    async writeLocalPasswordIfUnmanaged(input: LocalPasswordWrite) {
      await session.transaction(async (tx) => {
        await engine.lockAggregateRoot(tx, users, users.id, input.userId)
        const user = (
          await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1)
        )[0]
        if (user === undefined) {
          throw new NotFoundError('user-not-found', `user ${input.userId} not found`)
        }
        const identity = (
          await tx
            .select({ id: userIdentities.id })
            .from(userIdentities)
            .where(eq(userIdentities.userId, input.userId))
            .limit(1)
        )[0]
        if (identity !== undefined) {
          throw new ForbiddenError(
            'oidc-password-managed',
            'password is managed by the linked identity provider',
          )
        }
        await tx
          .update(users)
          .set({
            passwordHash: input.passwordHash,
            forcePasswordChange: input.forcePasswordChange,
            ...(input.activate ? { status: 'active' as const } : {}),
            updatedAt: input.updatedAt,
          })
          .where(eq(users.id, input.userId))
      })
    },
  }
}
