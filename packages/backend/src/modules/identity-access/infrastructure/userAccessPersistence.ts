// RFC-359 W4-D8 —— identity-access 账户 / 授权持久化：一份实现，两个 provider 共用。
//
// # 写模型
//
// 沿用 RFC-349 的「读集 → 同步纯决策 → 落库」形态（原 PostgreSQL 适配器的形状，现在也是 SQLite 的形状）：
// 应用层命令在一个**同步**回调里对预加载的账户快照做决策——`BufferedUserAccessTransaction` 只认读集里
// 声明过的行，未声明的读 fail closed——落库时按顺序回放缓冲的操作。两个引擎都走 `session.serializable`：
// PG 上 SERIALIZABLE + 40001 退避重试（「最后一个访问管理员」是谓词级不变量，READ COMMITTED + 行锁锁不住
// 「同时把两个管理员降级」这种交叠）；SQLite 上它就是 BEGIN IMMEDIATE。
//
// # 出站授权围栏（RFC-305 / RFC-317 T41）
//
// 端口是**同步**的：WS 发帧热路径必须在当前 tick 判定这一帧发不发。一份代码：先问能力矩阵 `readRowSync`
// （SQLite 驱动本身同步，跨进程写者——CLI 建号 / 改权——立即可见），引擎给不出同步读（PG 无法同步网络读）
// 就退回本进程缓存——缓存由授权读（findAccessSnapshot / listAccessSnapshots）预热、本进程写事务提交后刷新；
// 未命中回 null，传输层按 fail closed 处置。

import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  mcpRuntimeTestSessions,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPermissionGrants,
  users,
} from '@/db/schema'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import {
  affectedRows,
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { initialGrantsForRole } from '../domain/initialGrants'
import type { OidcIdentityRecord } from '../application/ports/oidcIdentityCrossContext'
import type { UserAccessAuditRecord } from '../application/ports/userAccessAuditRepository'
import type {
  AuthorityFenceRecord,
  ConditionalUserUpdate,
  InitialUserAccessProvision,
  InsertManagedUserRecord,
  OidcProfileIdentityRecord,
  OidcProfileIdentityUpdate,
  OidcProfileSelectorRecord,
  PublicUserRecord,
  UserAccessFenceReader,
  UserAccessReadRepository,
  UserAccessRecord,
  UserAccessSnapshot,
  UserPermissionGrantRecord,
} from '../application/ports/userAccessRepository'
import type {
  UserAccessTransaction,
  UserAccessTransactionReadSet,
  UserAccessTransactionRunner,
} from '../application/ports/userAccessTransaction'
import { UserAccessError, type ManagedUserStatus } from '../public/types'

type SynchronousDecision<T> = T extends PromiseLike<unknown> ? never : T

function identityKey(providerId: string, subject: string): string {
  return `${providerId}\u0000${subject}`
}

function grantKey(userId: string, permission: string): string {
  return `${userId}\u0000${permission}`
}

function mapUser(row: typeof users.$inferSelect): UserAccessRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    gitName: row.gitName,
    passwordHash: row.passwordHash,
    role: row.role as Role,
    status: row.status as ManagedUserStatus,
    forcePasswordChange: row.forcePasswordChange,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
    schemaVersion: row.schemaVersion,
    accessRevision: row.accessRevision,
  }
}

function mapGrant(row: typeof userPermissionGrants.$inferSelect): UserPermissionGrantRecord {
  return {
    userId: row.userId,
    permission: row.permission,
    grantedByUserId: row.grantedByUserId,
    grantedAt: row.grantedAt,
  }
}

function mapPublicUser(row: {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: string
  readonly status: string
}): PublicUserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as Role,
    status: row.status as ManagedUserStatus,
  }
}

/**
 * 本进程的围栏缓存（两个引擎都维护）：授权读预热、写事务提交后刷新。SQLite 上只是同步读的影子——
 * `readRowSync` 总能给出新鲜行；PG 上它就是围栏本身（RFC-349：单 daemon 世代，跨 daemon 失效不在范围内）。
 */
export class AuthorityFenceCache {
  private readonly records = new Map<string, AuthorityFenceRecord>()

  read(id: string): AuthorityFenceRecord | null {
    return this.records.get(id) ?? null
  }

  remember(user: Pick<UserAccessRecord, 'id' | 'status' | 'accessRevision'>): void {
    this.records.set(user.id, { status: user.status, accessRevision: user.accessRevision })
  }
}

interface RawAuthorityFenceRow {
  readonly status: string
  readonly access_revision: number
}

const PUBLIC_USER_COLUMNS = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  status: users.status,
}

export function createUserAccessRepository(
  db: ProviderNeutralDatabase,
  fenceCache: AuthorityFenceCache,
): UserAccessReadRepository & UserAccessFenceReader {
  const engine = databaseSessionFor(db).engine
  return {
    /**
     * 围栏读不 try/catch：失败由调用方按自己的语义处置（围栏的语义是 fail closed——读不到就当授权已失效），
     * 在这里吞掉会让两种调用方共用一套错误处置。`users.status` / `users.access_revision` 是本 context 拥有
     * 的列，这条 SQL 待在拥有那张表的 context 里，列改名时与 schema 一起改。
     */
    readAuthorityFence(id) {
      const fresh = engine.readRowSync(
        db,
        sql`SELECT status, access_revision FROM users WHERE id = ${id} LIMIT 1`,
      )
      if (fresh === undefined) return fenceCache.read(id)
      if (fresh === null) return null
      const row = fresh as unknown as RawAuthorityFenceRow
      return { status: row.status as ManagedUserStatus, accessRevision: row.access_revision }
    },

    async findByUsername(username) {
      const row = (
        await db
          .select(PUBLIC_USER_COLUMNS)
          .from(users)
          .where(and(ne(users.id, SYSTEM_USER_ID), eq(users.username, username)))
          .limit(1)
      )[0]
      return row === undefined ? null : mapPublicUser(row)
    },

    async search(input) {
      const q = (input.q ?? '').trim().toLowerCase()
      const excluded = new Set(input.excludeIds)
      const rows = await db
        .select(PUBLIC_USER_COLUMNS)
        .from(users)
        .where(
          and(
            ne(users.id, SYSTEM_USER_ID),
            q.length === 0
              ? undefined
              : or(
                  sql`lower(${users.username}) LIKE ${`${q}%`}`,
                  sql`lower(${users.displayName}) LIKE ${`${q}%`}`,
                ),
            input.status === undefined ? undefined : eq(users.status, input.status),
            input.status === undefined && excluded.size > 0
              ? ne(users.status, 'disabled')
              : undefined,
          ),
        )
        .orderBy(asc(users.createdAt), asc(users.id))
      return rows
        .filter((row) => !excluded.has(row.id))
        .slice(0, input.limit)
        .map(mapPublicUser)
    },

    async lookup(ids) {
      const wanted = [...new Set(ids)].filter((id) => id !== SYSTEM_USER_ID)
      if (wanted.length === 0) return []
      const rows = await db.select(PUBLIC_USER_COLUMNS).from(users).where(inArray(users.id, wanted))
      const byId = new Map(rows.map((row) => [row.id, mapPublicUser(row)]))
      return wanted.flatMap((id) => {
        const row = byId.get(id)
        return row === undefined ? [] : [row]
      })
    },

    async findAccessSnapshot(id) {
      const rows = await db
        .select({ user: users, grant: userPermissionGrants })
        .from(users)
        .leftJoin(userPermissionGrants, eq(userPermissionGrants.userId, users.id))
        .where(eq(users.id, id))
        .orderBy(asc(userPermissionGrants.permission))
      const first = rows[0]
      if (first === undefined) return null
      const snapshot: UserAccessSnapshot = {
        user: mapUser(first.user),
        grants: rows.flatMap((row) => (row.grant === null ? [] : [mapGrant(row.grant)])),
      }
      fenceCache.remember(snapshot.user)
      return snapshot
    },

    async listAccessSnapshots() {
      const rows = await db
        .select({ user: users, grant: userPermissionGrants })
        .from(users)
        .leftJoin(userPermissionGrants, eq(userPermissionGrants.userId, users.id))
        .orderBy(asc(users.createdAt), asc(users.id), asc(userPermissionGrants.permission))
      const grouped = new Map<string, UserAccessSnapshot>()
      for (const row of rows) {
        let current = grouped.get(row.user.id) ?? { user: mapUser(row.user), grants: [] }
        if (row.grant !== null) {
          current = { ...current, grants: [...current.grants, mapGrant(row.grant)] }
        }
        grouped.set(row.user.id, current)
      }
      return [...grouped.values()].map((snapshot) => {
        fenceCache.remember(snapshot.user)
        return snapshot
      })
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 写模型：缓冲的同步决策参与者 + 读集装载 + 操作回放
// ─────────────────────────────────────────────────────────────────────────────

export type UserAccessOperation =
  | { readonly kind: 'insert-user'; readonly record: InsertManagedUserRecord }
  | { readonly kind: 'update-user'; readonly update: ConditionalUserUpdate }
  | { readonly kind: 'activate-user'; readonly userId: string; readonly now: number }
  | { readonly kind: 'update-oidc-identity'; readonly update: OidcProfileIdentityUpdate }
  | { readonly kind: 'insert-identity'; readonly record: OidcIdentityRecord }
  | { readonly kind: 'delete-grant'; readonly userId: string; readonly permission: string }
  | {
      readonly kind: 'insert-grant'
      readonly record: {
        readonly userId: string
        readonly permission: Permission
        readonly grantedByUserId: string | null
        readonly grantedAt: number
      }
    }
  | { readonly kind: 'transition-disabled-owner'; readonly userId: string; readonly now: number }
  | { readonly kind: 'append-audit'; readonly record: UserAccessAuditRecord }

export interface LoadedUserAccessState {
  readonly users: ReadonlyArray<UserAccessRecord>
  readonly grants: ReadonlyArray<UserPermissionGrantRecord>
  readonly oidcIdentity: OidcProfileIdentityRecord | null
  readonly oidcSelectors: OidcProfileSelectorRecord | null
}

export class BufferedUserAccessTransaction implements UserAccessTransaction {
  readonly operations: UserAccessOperation[] = []
  private readonly users = new Map<string, UserAccessRecord>()
  private readonly usernames = new Map<string, string>()
  private readonly emails = new Map<string, string>()
  private readonly grants = new Map<string, UserPermissionGrantRecord>()
  private readonly oidcIdentities = new Map<string, OidcProfileIdentityRecord>()
  private readonly selectors = new Map<string, OidcProfileSelectorRecord>()
  private readonly touchedUsers = new Set<string>()

  constructor(
    private readonly readSet: UserAccessTransactionReadSet,
    state: LoadedUserAccessState,
  ) {
    for (const user of state.users) this.storeUser(user)
    for (const grant of state.grants) {
      this.grants.set(grantKey(grant.userId, grant.permission), grant)
    }
    if (state.oidcIdentity !== null && readSet.oidcProfileIdentity !== undefined) {
      this.oidcIdentities.set(
        identityKey(readSet.oidcProfileIdentity.providerId, readSet.oidcProfileIdentity.subject),
        state.oidcIdentity,
      )
    }
    if (state.oidcSelectors !== null && readSet.oidcProfileSelectorsProviderId !== undefined) {
      this.selectors.set(readSet.oidcProfileSelectorsProviderId, state.oidcSelectors)
    }
  }

  private storeUser(user: UserAccessRecord): void {
    const previous = this.users.get(user.id)
    if (previous !== undefined) {
      this.usernames.delete(previous.username)
      if (previous.email !== null) this.emails.delete(previous.email)
    }
    this.users.set(user.id, user)
    this.usernames.set(user.username, user.id)
    if (user.email !== null) this.emails.set(user.email, user.id)
  }

  private assertRequested(
    values: ReadonlyArray<string> | undefined,
    value: string,
    kind: string,
  ): void {
    if (values?.includes(value) === true) return
    throw new Error(
      `identity-access ${kind} '${value}' was not declared in the transaction read-set`,
    )
  }

  findUser(id: string): UserAccessRecord | null {
    this.assertRequested(this.readSet.userIds, id, 'user id')
    return this.users.get(id) ?? null
  }

  findUserByUsername(username: string): UserAccessRecord | null {
    this.assertRequested(this.readSet.usernames, username, 'username')
    const id = this.usernames.get(username)
    return id === undefined ? null : (this.users.get(id) ?? null)
  }

  findUserByEmail(email: string): UserAccessRecord | null {
    this.assertRequested(this.readSet.emails, email, 'email')
    const id = this.emails.get(email)
    return id === undefined ? null : (this.users.get(id) ?? null)
  }

  findOidcProfileIdentity(providerId: string, subject: string): OidcProfileIdentityRecord | null {
    const requested = this.readSet.oidcProfileIdentity
    if (requested?.providerId !== providerId || requested.subject !== subject) {
      throw new Error('identity-access OIDC identity was not declared in the transaction read-set')
    }
    return this.oidcIdentities.get(identityKey(providerId, subject)) ?? null
  }

  findOidcProfileSelectors(providerId: string): OidcProfileSelectorRecord | null {
    if (this.readSet.oidcProfileSelectorsProviderId !== providerId) {
      throw new Error(
        'identity-access OIDC selectors were not declared in the transaction read-set',
      )
    }
    return this.selectors.get(providerId) ?? null
  }

  updateOidcProfileIdentity(update: OidcProfileIdentityUpdate): void {
    const identity = [...this.oidcIdentities.values()].find(
      (candidate) => candidate.id === update.id,
    )
    if (identity === undefined) throw new Error('identity-access OIDC identity was not loaded')
    const next = { ...identity, ...update }
    for (const [key, candidate] of this.oidcIdentities) {
      if (candidate.id === update.id) this.oidcIdentities.set(key, next)
    }
    this.operations.push({ kind: 'update-oidc-identity', update })
  }

  listGrants(userId: string): ReadonlyArray<UserPermissionGrantRecord> {
    const allowed =
      this.readSet.grantUserIds?.includes(userId) === true ||
      this.readSet.activeAccessAdministrators === true
    if (!allowed) {
      throw new Error(`identity-access grants for '${userId}' were not declared in the read-set`)
    }
    return [...this.grants.values()]
      .filter((grant) => grant.userId === userId)
      .sort((left, right) => left.permission.localeCompare(right.permission))
  }

  countOtherActiveAccessAdministrators(excludeId: string, systemUserId: string): number {
    if (this.readSet.activeAccessAdministrators !== true) {
      throw new Error('active access administrators were not declared in the read-set')
    }
    return [...this.users.values()].filter((user) => {
      if (user.id === excludeId || user.id === systemUserId || user.status !== 'active') {
        return false
      }
      const additionalPermissions = normalizeStoredAdditionalPermissions({
        role: user.role,
        additionalPermissions: this.listGrants(user.id).map((grant) => grant.permission),
      }).additionalPermissions
      return resolveEffectiveAccountPermissions({ role: user.role, additionalPermissions }).has(
        'users:write',
      )
    }).length
  }

  insertUser(record: InsertManagedUserRecord): void {
    this.storeUser(record)
    this.touchedUsers.add(record.id)
    this.operations.push({ kind: 'insert-user', record })
  }

  updateUserConditional(update: ConditionalUserUpdate): boolean {
    const current = this.users.get(update.id)
    if (current === undefined) return false
    if (update.accessChanged && current.accessRevision !== update.expectedAccessRevision) {
      return false
    }
    this.storeUser({ ...current, ...update.values })
    this.touchedUsers.add(update.id)
    this.operations.push({ kind: 'update-user', update })
    return true
  }

  deleteGrantValue(userId: string, permission: string): void {
    this.grants.delete(grantKey(userId, permission))
    this.operations.push({ kind: 'delete-grant', userId, permission })
  }

  deleteGrant(userId: string, permission: Permission): void {
    this.deleteGrantValue(userId, permission)
  }

  insertGrant(record: {
    readonly userId: string
    readonly permission: Permission
    readonly grantedByUserId: string | null
    readonly grantedAt: number
  }): void {
    this.grants.set(grantKey(record.userId, record.permission), record)
    this.operations.push({ kind: 'insert-grant', record })
  }

  transitionDisabledOwner(userId: string, now: number): void {
    this.operations.push({ kind: 'transition-disabled-owner', userId, now })
  }

  appendAudit(record: UserAccessAuditRecord): void {
    this.operations.push({ kind: 'append-audit', record })
  }

  committedFenceRecords(): ReadonlyArray<UserAccessRecord> {
    return [...this.touchedUsers].flatMap((id) => {
      const user = this.users.get(id)
      return user === undefined ? [] : [user]
    })
  }
}

/**
 * 建号时的初始账户 / 默认授权 / 审计，三者共用同一个授权数组（RFC-312：否则会出现「权限生效了但审计里
 * 查不到是谁给的」）。OIDC 自助建号走这里；bootstrap 首管理员由 auth 自己落（admin 没有默认附加授权）。
 */
export function stageInitialUserAccess(
  participant: UserAccessTransaction,
  provision: InitialUserAccessProvision,
): void {
  participant.insertUser({
    ...provision.user,
    updatedAt: provision.user.createdAt,
    lastLoginAt: null,
    schemaVersion: 1,
    accessRevision: 0,
  })
  const initialGrants = initialGrantsForRole(provision.user.role)
  for (const permission of initialGrants) {
    participant.insertGrant({
      userId: provision.user.id,
      // 系统默认授予（不是某个操作者点的），与显式授予在归属上可区分。
      grantedByUserId: null,
      permission,
      grantedAt: provision.user.createdAt,
    })
  }
  participant.appendAudit({
    ...provision.audit,
    targetUserId: provision.user.id,
    correlationId: provision.audit.operationId,
    beforeRole: provision.user.role,
    afterRole: provision.user.role,
    addedPermissions: initialGrants,
    removedPermissions: [],
    accessRevision: 0,
    createdAt: provision.user.createdAt,
  })
}

export async function loadUserAccessState(
  tx: DatabaseTransaction,
  readSet: UserAccessTransactionReadSet,
): Promise<LoadedUserAccessState> {
  const loadedUsers = new Map<string, UserAccessRecord>()
  const loadRows = async (condition: SQL<unknown>): Promise<void> => {
    const rows = await tx.select().from(users).where(condition)
    for (const row of rows) loadedUsers.set(row.id, mapUser(row))
  }

  const userIds = [...new Set(readSet.userIds ?? [])]
  if (userIds.length > 0) await loadRows(inArray(users.id, userIds))
  const usernames = [...new Set(readSet.usernames ?? [])]
  if (usernames.length > 0) await loadRows(inArray(users.username, usernames))
  const emails = [...new Set(readSet.emails ?? [])]
  if (emails.length > 0) await loadRows(inArray(users.email, emails))
  if (readSet.activeAccessAdministrators === true) await loadRows(eq(users.status, 'active'))

  const grantUserIds = new Set(readSet.grantUserIds ?? [])
  if (readSet.activeAccessAdministrators === true) {
    for (const user of loadedUsers.values()) {
      if (user.status === 'active') grantUserIds.add(user.id)
    }
  }
  const grants =
    grantUserIds.size === 0
      ? []
      : (
          await tx
            .select()
            .from(userPermissionGrants)
            .where(inArray(userPermissionGrants.userId, [...grantUserIds]))
        ).map(mapGrant)

  let oidcIdentity: OidcProfileIdentityRecord | null = null
  if (readSet.oidcProfileIdentity !== undefined) {
    const row = (
      await tx
        .select({
          id: userIdentities.id,
          userId: userIdentities.userId,
          email: userIdentities.email,
          emailVerified: userIdentities.emailVerified,
          preferredSnapshot: userIdentities.preferredSnapshot,
        })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.providerId, readSet.oidcProfileIdentity.providerId),
            eq(userIdentities.subject, readSet.oidcProfileIdentity.subject),
          ),
        )
        .limit(1)
    )[0]
    oidcIdentity = row === undefined ? null : { ...row, emailVerified: row.emailVerified === 1 }
  }

  let oidcSelectors: OidcProfileSelectorRecord | null = null
  if (readSet.oidcProfileSelectorsProviderId !== undefined) {
    const row = (
      await tx
        .select({
          subjectClaim: oidcProviders.subjectClaim,
          usernameClaim: oidcProviders.usernameClaim,
          gitNameClaim: oidcProviders.gitNameClaim,
          emailClaim: oidcProviders.emailClaim,
        })
        .from(oidcProviders)
        .where(eq(oidcProviders.id, readSet.oidcProfileSelectorsProviderId))
        .limit(1)
    )[0]
    oidcSelectors = row ?? null
  }

  return { users: [...loadedUsers.values()], grants, oidcIdentity, oidcSelectors }
}

/** 按顺序回放缓冲的操作。`update-user` 的 CAS 判据「恰好 1 行」在两个引擎上都成立（`affectedRows`）。 */
export async function persistUserAccessOperations(
  tx: DatabaseTransaction,
  operations: ReadonlyArray<UserAccessOperation>,
): Promise<void> {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'insert-user':
        await tx.insert(users).values({
          id: operation.record.id,
          username: operation.record.username,
          email: operation.record.email,
          displayName: operation.record.displayName,
          gitName: operation.record.gitName,
          passwordHash: operation.record.passwordHash,
          role: operation.record.role,
          status: operation.record.status,
          forcePasswordChange: operation.record.forcePasswordChange,
          createdBy: operation.record.createdBy,
          createdAt: operation.record.createdAt,
          updatedAt: operation.record.updatedAt,
          lastLoginAt: operation.record.lastLoginAt,
          schemaVersion: operation.record.schemaVersion,
          accessRevision: operation.record.accessRevision,
        })
        break
      case 'update-user': {
        const values: Partial<typeof users.$inferInsert> = {}
        const patch = operation.update.values
        if (patch.displayName !== undefined) values.displayName = patch.displayName
        if (patch.gitName !== undefined) values.gitName = patch.gitName
        if (Object.prototype.hasOwnProperty.call(patch, 'email')) values.email = patch.email
        if (patch.role !== undefined) values.role = patch.role
        if (patch.status !== undefined) values.status = patch.status
        if (patch.forcePasswordChange !== undefined) {
          values.forcePasswordChange = patch.forcePasswordChange
        }
        if (patch.accessRevision !== undefined) values.accessRevision = patch.accessRevision
        if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt
        const result = await tx
          .update(users)
          .set(values)
          .where(
            operation.update.accessChanged
              ? and(
                  eq(users.id, operation.update.id),
                  eq(users.accessRevision, operation.update.expectedAccessRevision),
                )
              : eq(users.id, operation.update.id),
          )
        if (affectedRows(result) !== 1) {
          throw new UserAccessError(
            'conflict',
            operation.update.accessChanged ? 'user-access-stale' : 'profile-update-conflict',
            operation.update.accessChanged ? 'user access changed' : 'profile changed',
          )
        }
        break
      }
      case 'activate-user':
        await tx
          .update(users)
          .set({ status: 'active', updatedAt: operation.now })
          .where(eq(users.id, operation.userId))
        break
      case 'update-oidc-identity': {
        const values: Partial<typeof userIdentities.$inferInsert> = {}
        if (operation.update.email !== undefined) values.email = operation.update.email
        if (operation.update.emailVerified !== undefined) {
          values.emailVerified = operation.update.emailVerified ? 1 : 0
        }
        if (operation.update.preferredSnapshot !== undefined) {
          values.preferredSnapshot = operation.update.preferredSnapshot
        }
        await tx
          .update(userIdentities)
          .set(values)
          .where(eq(userIdentities.id, operation.update.id))
        break
      }
      case 'insert-identity':
        await tx.insert(userIdentities).values(operation.record)
        break
      case 'delete-grant':
        await tx
          .delete(userPermissionGrants)
          .where(
            and(
              eq(userPermissionGrants.userId, operation.userId),
              eq(userPermissionGrants.permission, operation.permission),
            ),
          )
        break
      case 'insert-grant':
        await tx.insert(userPermissionGrants).values(operation.record)
        break
      case 'transition-disabled-owner':
        // 账号禁用时结束它名下所有活跃的 MCP runtime 试跑会话（原 SQLite 侧经 mcpRuntimeTestTransitions 的
        // 同步助手逐行 end；两边语义一致：状态 ending、原因 access-revoked、版本 +1）。
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: 'access-revoked',
            idleDeadlineAt: null,
            sessionVersion: sql`${mcpRuntimeTestSessions.sessionVersion} + 1`,
            updatedAt: operation.now,
          })
          .where(
            and(
              eq(mcpRuntimeTestSessions.ownerUserId, operation.userId),
              eq(mcpRuntimeTestSessions.status, 'active'),
            ),
          )
        break
      case 'append-audit':
        await tx.insert(userAccessAudit).values({
          id: operation.record.id,
          targetUserId: operation.record.targetUserId,
          actorUserId: operation.record.actorUserId,
          actorKind: operation.record.actorKind,
          operationId: operation.record.operationId,
          correlationId: operation.record.correlationId,
          beforeRole: operation.record.beforeRole,
          afterRole: operation.record.afterRole,
          addedPermissionsJson: JSON.stringify(operation.record.addedPermissions),
          removedPermissionsJson: JSON.stringify(operation.record.removedPermissions),
          accessRevision: operation.record.accessRevision,
          createdAt: operation.record.createdAt,
        })
        break
    }
  }
}

/**
 * 驱动的唯一冲突 → 命令的闭合错误合同。约束身份经能力矩阵 `uniqueViolationTarget` 取：PG 是约束名
 * （`users_username_unique`），SQLite 是 `UNIQUE constraint failed:` 后的列表（`users.username`）——同一条
 * 正则两边都认。
 */
export function mapUserAccessError(
  engine: EngineCapabilities,
  error: unknown,
  operation: UserAccessTransactionReadSet['operation'],
): unknown {
  if (error instanceof UserAccessError) return error
  const target = engine.uniqueViolationTarget(error)
  if (target === undefined) return error
  if (/users[._]username/i.test(target)) {
    return new UserAccessError('conflict', 'username-taken', 'username already exists')
  }
  if (/users[._]email/i.test(target)) {
    if (operation === 'sync-oidc-profile') {
      return new UserAccessError(
        'conflict',
        'oidc-email-conflict',
        'the identity provider email already belongs to another user',
      )
    }
    return new UserAccessError(
      'conflict',
      'profile-email-conflict',
      'email already belongs to another user',
    )
  }
  return error
}

export function createUserAccessTransactionRunner(
  db: ProviderNeutralDatabase,
  fenceCache: AuthorityFenceCache,
): UserAccessTransactionRunner {
  const session = databaseSessionFor(db)
  return {
    async run<T>(
      readSet: UserAccessTransactionReadSet,
      body: (transaction: UserAccessTransaction) => SynchronousDecision<T>,
    ): Promise<T> {
      let committed: { readonly value: T; readonly fenceRecords: ReadonlyArray<UserAccessRecord> }
      try {
        committed = await session.serializable(async (tx) => {
          const state = await loadUserAccessState(tx, readSet)
          const buffered = new BufferedUserAccessTransaction(readSet, state)
          const value = body(buffered)
          await persistUserAccessOperations(tx, buffered.operations)
          return { value, fenceRecords: buffered.committedFenceRecords() }
        })
      } catch (error) {
        throw mapUserAccessError(session.engine, error, readSet.operation)
      }
      for (const user of committed.fenceRecords) fenceCache.remember(user)
      return committed.value
    },
  }
}
