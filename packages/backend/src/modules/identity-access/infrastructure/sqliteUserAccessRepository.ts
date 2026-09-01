import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { initialGrantsForRole } from '../domain/initialGrants'
import { oidcProviders, userIdentities, users } from '@/db/schema'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import type { TransactionScope } from '@/platform/persistence/transactionScope'
import { withSQLiteTransaction } from '@/platform/persistence/sqlite/existingTransactionScope'
import { transitionOwnerRuntimeTestsInTx } from '@/services/mcpRuntimeTestTransitions'
import type {
  AuthorityFenceRecord,
  ConditionalUserUpdate,
  InsertManagedUserRecord,
  OidcProfileIdentityUpdate,
  PublicUserRecord,
  PublicUserSearch,
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
import type { UserAccessAuditRecord } from '../application/ports/userAccessAuditRepository'
import type { ManagedUserStatus } from '../public/types'
import type { InitialUserAccessProvision } from '../public/participants'
import { appendUserAccessAudit } from './sqliteUserAccessAuditRepository'
import {
  mapOidcEmailConstraint,
  syncOidcProfileTransaction,
  type SyncOidcProfileCommand,
  type SyncOidcProfileResult,
} from '../application/commands/syncOidcProfile'

interface RawUserAccessRow {
  id: string
  username: string
  email: string | null
  display_name: string
  git_name: string
  password_hash: string | null
  role: string
  status: string
  force_password_change: number
  created_by: string | null
  created_at: number
  updated_at: number
  last_login_at: number | null
  schema_version: number
  access_revision: number
}

interface RawGrantRow {
  user_id: string
  permission: string
  granted_by_user_id: string | null
  granted_at: number
}

interface RawAccessSnapshotRow extends RawUserAccessRow {
  grant_user_id: string | null
  grant_permission: string | null
  grant_granted_by_user_id: string | null
  grant_granted_at: number | null
}

const USER_SELECT = sql.raw(`
  SELECT id, username, email, display_name, git_name, password_hash, role, status,
         force_password_change, created_by, created_at, updated_at,
         last_login_at, schema_version, access_revision
  FROM users
`)

const ACCESS_SNAPSHOT_SELECT = sql.raw(`
  SELECT u.id, u.username, u.email, u.display_name, u.git_name, u.password_hash,
         u.role, u.status, u.force_password_change, u.created_by,
         u.created_at, u.updated_at, u.last_login_at, u.schema_version,
         u.access_revision,
         g.user_id AS grant_user_id,
         g.permission AS grant_permission,
         g.granted_by_user_id AS grant_granted_by_user_id,
         g.granted_at AS grant_granted_at
  FROM users AS u
  LEFT JOIN user_permission_grants AS g ON g.user_id = u.id
`)

interface RawAuthorityFenceRow {
  readonly status: string
  readonly access_revision: number
}

const AUTHORITY_FENCE_SQL = 'SELECT status, access_revision FROM users WHERE id = ? LIMIT 1'

export class SQLiteUserAccessRepository implements UserAccessReadRepository, UserAccessFenceReader {
  constructor(private readonly db: DbClient) {}

  /**
   * RFC-317 T41 —— 同步围栏读。用 raw client 是刻意的（消费者是 WS 发帧热路径，
   * 见端口注释），但**这条 SQL 现在待在拥有 `users` 表的 context 里**：列改名时它和
   * schema 一起被改，而不是留在传输层等运行期爆炸。
   *
   * 不 try/catch：失败该由调用方按自己的语义处置（围栏的语义是 fail closed——
   * 读不到就当授权已失效），在这里吞掉会让两种调用方共用一套错误处置。
   */
  readAuthorityFence(id: string): AuthorityFenceRecord | null {
    const row = this.db.$client.query(AUTHORITY_FENCE_SQL).get(id) as RawAuthorityFenceRow | null
    if (row === null) return null
    return { status: row.status as ManagedUserStatus, accessRevision: row.access_revision }
  }

  async findByUsername(username: string): Promise<PublicUserRecord | null> {
    const row = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(and(ne(users.id, SYSTEM_USER_ID), eq(users.username, username)))
      .limit(1)
      .get()
    return row === undefined ? null : mapPublicUser(row)
  }

  async search(input: PublicUserSearch): Promise<ReadonlyArray<PublicUserRecord>> {
    const q = (input.q ?? '').trim().toLowerCase()
    const excluded = new Set(input.excludeIds)
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      })
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
      .all()
    return rows
      .filter((row) => !excluded.has(row.id))
      .slice(0, input.limit)
      .map(mapPublicUser)
  }

  async lookup(ids: ReadonlyArray<string>): Promise<ReadonlyArray<PublicUserRecord>> {
    const wanted = [...new Set(ids)].filter((id) => id !== SYSTEM_USER_ID)
    if (wanted.length === 0) return []
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(inArray(users.id, wanted))
      .all()
    const byId = new Map(rows.map((row) => [row.id, mapPublicUser(row)]))
    return wanted.flatMap((id) => {
      const row = byId.get(id)
      return row === undefined ? [] : [row]
    })
  }

  async findAccessSnapshot(id: string): Promise<UserAccessSnapshot | null> {
    const rows = (await this.db.all(sql`
      ${ACCESS_SNAPSHOT_SELECT}
      WHERE u.id = ${id}
      ORDER BY g.permission
    `)) as RawAccessSnapshotRow[]
    return rows.length === 0 ? null : mapAccessSnapshot(rows)
  }

  async listAccessSnapshots(): Promise<ReadonlyArray<UserAccessSnapshot>> {
    const rows = (await this.db.all(sql`
      ${ACCESS_SNAPSHOT_SELECT}
      ORDER BY u.created_at, u.id, g.permission
    `)) as RawAccessSnapshotRow[]
    const grouped = new Map<string, RawAccessSnapshotRow[]>()
    for (const row of rows) {
      const current = grouped.get(row.id) ?? []
      current.push(row)
      grouped.set(row.id, current)
    }
    return [...grouped.values()].map(mapAccessSnapshot)
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

export class SQLiteUserAccessTransactionRunner implements UserAccessTransactionRunner {
  constructor(private readonly db: DbClient) {}

  async run<T>(
    _readSet: UserAccessTransactionReadSet,
    body: (transaction: UserAccessTransaction) => NotPromise<T>,
  ): Promise<T> {
    return dbTxSync(this.db, (transaction) => body(new SQLiteUserAccessTransaction(transaction)))
  }
}

/** Exact transaction participant for cross-context account provisioning.
 * Bootstrap/OIDC keep their adjacent writes in the same SQLite transaction,
 * while the identity-access infrastructure remains the sole role/revision and
 * access-audit writer. */
export function insertInitialUserAccessInTransaction(
  transactionScope: TransactionScope,
  provision: InitialUserAccessProvision,
): void {
  withSQLiteTransaction(transactionScope, (transaction) => {
    const participant = new SQLiteUserAccessTransaction(transaction)
    participant.insertUser({
      ...provision.user,
      updatedAt: provision.user.createdAt,
      lastLoginAt: null,
      schemaVersion: 1,
      accessRevision: 0,
    })
    // RFC-312 —— 这条路径（OIDC 自助建号 / bootstrap 首管理员）此前**一条 grant 都不插**，
    // 于是"新建非 guest 默认授予"在这里被静默绕过：OIDC 默认角色若配成 user，
    // 新账号是 active user 却拿不到 users:presence，开着界面也不会被同事看到在线。
    // 默认授权与审计**共用同一个数组**——否则会出现"权限生效了但审计查不到是谁给的"。
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
    return undefined
  })
}

/** Cross-context bridge for OIDC create/bind/link, whose identity row must be
 * inserted in the same SQLite transaction as the identity-access profile
 * refresh. The Drizzle handle remains infrastructure-private. */
export function syncOidcProfileInTransaction(
  transactionScope: TransactionScope,
  command: SyncOidcProfileCommand,
  now = Date.now(),
): SyncOidcProfileResult {
  let result: SyncOidcProfileResult | undefined
  try {
    withSQLiteTransaction(transactionScope, (transaction) => {
      result = syncOidcProfileTransaction(new SQLiteUserAccessTransaction(transaction), command, {
        now,
        operationId: ulid(),
        auditId: ulid,
      })
      return undefined
    })
  } catch (error) {
    throw mapOidcEmailConstraint(error)
  }
  if (result === undefined) throw new Error('OIDC profile transaction did not execute')
  return result
}

class SQLiteUserAccessTransaction implements UserAccessTransaction {
  constructor(private readonly transaction: DbTxSync) {}

  findUser(id: string): UserAccessRecord | null {
    const rows = this.transaction.all(
      sql`${USER_SELECT} WHERE id = ${id} LIMIT 1`,
    ) as RawUserAccessRow[]
    return rows[0] === undefined ? null : mapUser(rows[0])
  }

  findUserByUsername(username: string): UserAccessRecord | null {
    const rows = this.transaction.all(
      sql`${USER_SELECT} WHERE username = ${username} LIMIT 1`,
    ) as RawUserAccessRow[]
    return rows[0] === undefined ? null : mapUser(rows[0])
  }

  findUserByEmail(email: string): UserAccessRecord | null {
    const rows = this.transaction.all(
      sql`${USER_SELECT} WHERE email = ${email} LIMIT 1`,
    ) as RawUserAccessRow[]
    return rows[0] === undefined ? null : mapUser(rows[0])
  }

  findOidcProfileIdentity(providerId: string, subject: string) {
    const row = this.transaction
      .select({
        id: userIdentities.id,
        userId: userIdentities.userId,
        email: userIdentities.email,
        emailVerified: userIdentities.emailVerified,
        preferredSnapshot: userIdentities.preferredSnapshot,
      })
      .from(userIdentities)
      .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.subject, subject)))
      .limit(1)
      .all()[0]
    return row === undefined ? null : { ...row, emailVerified: row.emailVerified === 1 }
  }

  findOidcProfileSelectors(providerId: string) {
    const row = this.transaction
      .select({
        subjectClaim: oidcProviders.subjectClaim,
        usernameClaim: oidcProviders.usernameClaim,
        gitNameClaim: oidcProviders.gitNameClaim,
        emailClaim: oidcProviders.emailClaim,
      })
      .from(oidcProviders)
      .where(eq(oidcProviders.id, providerId))
      .limit(1)
      .all()[0]
    return row ?? null
  }

  updateOidcProfileIdentity(update: OidcProfileIdentityUpdate): void {
    const values: Partial<typeof userIdentities.$inferInsert> = {}
    if (update.email !== undefined) values.email = update.email
    if (update.emailVerified !== undefined) {
      values.emailVerified = update.emailVerified ? 1 : 0
    }
    if (update.preferredSnapshot !== undefined) {
      values.preferredSnapshot = update.preferredSnapshot
    }
    this.transaction
      .update(userIdentities)
      .set(values)
      .where(eq(userIdentities.id, update.id))
      .run()
  }

  listGrants(userId: string): ReadonlyArray<UserPermissionGrantRecord> {
    const rows = this.transaction.all(sql`
      SELECT user_id, permission, granted_by_user_id, granted_at
      FROM user_permission_grants
      WHERE user_id = ${userId}
      ORDER BY permission
    `) as RawGrantRow[]
    return rows.map(mapGrant)
  }

  countOtherActiveAccessAdministrators(excludeId: string, systemUserId: string): number {
    const rows = this.transaction.all(sql`
      SELECT id, role
      FROM users
      WHERE status = 'active'
        AND id <> ${excludeId}
        AND id <> ${systemUserId}
    `) as Array<{ id: string; role: Role }>
    return rows.filter((row) => {
      const additionalPermissions = normalizeStoredAdditionalPermissions({
        role: row.role,
        additionalPermissions: this.listGrants(row.id).map((grant) => grant.permission),
      }).additionalPermissions
      return resolveEffectiveAccountPermissions({
        role: row.role,
        additionalPermissions,
      }).has('users:write')
    }).length
  }

  insertUser(record: InsertManagedUserRecord): void {
    this.transaction
      .insert(users)
      .values({
        id: record.id,
        username: record.username,
        email: record.email,
        displayName: record.displayName,
        gitName: record.gitName,
        passwordHash: record.passwordHash,
        role: record.role,
        status: record.status,
        forcePasswordChange: record.forcePasswordChange,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastLoginAt: record.lastLoginAt,
        schemaVersion: record.schemaVersion,
      })
      .run()
  }

  updateUserConditional(update: ConditionalUserUpdate): boolean {
    const values: Partial<typeof users.$inferInsert> = {}
    if (update.values.displayName !== undefined) values.displayName = update.values.displayName
    if (update.values.gitName !== undefined) values.gitName = update.values.gitName
    if (Object.prototype.hasOwnProperty.call(update.values, 'email')) {
      values.email = update.values.email
    }
    if (update.values.role !== undefined) values.role = update.values.role
    if (update.values.status !== undefined) values.status = update.values.status
    if (update.values.forcePasswordChange !== undefined) {
      values.forcePasswordChange = update.values.forcePasswordChange
    }
    if (update.values.accessRevision !== undefined) {
      values.accessRevision = update.values.accessRevision
    }
    if (update.values.updatedAt !== undefined) values.updatedAt = update.values.updatedAt

    const result = this.transaction
      .update(users)
      .set(values)
      .where(
        update.accessChanged
          ? and(eq(users.id, update.id), eq(users.accessRevision, update.expectedAccessRevision))
          : eq(users.id, update.id),
      )
      .run()
    return changesOf(result) === 1
  }

  deleteGrantValue(userId: string, permission: string): void {
    this.transaction.run(sql`
      DELETE FROM user_permission_grants
      WHERE user_id = ${userId} AND permission = ${permission}
    `)
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
    this.transaction.run(sql`
      INSERT INTO user_permission_grants (
        user_id, permission, granted_by_user_id, granted_at
      ) VALUES (
        ${record.userId}, ${record.permission}, ${record.grantedByUserId}, ${record.grantedAt}
      )
    `)
  }

  transitionDisabledOwner(userId: string, now: number): void {
    transitionOwnerRuntimeTestsInTx(this.transaction, userId, now)
  }

  appendAudit(record: UserAccessAuditRecord): void {
    appendUserAccessAudit(this.transaction, record)
  }
}

function mapUser(row: RawUserAccessRow): UserAccessRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    gitName: row.git_name,
    passwordHash: row.password_hash,
    role: row.role as Role,
    status: row.status as UserAccessRecord['status'],
    forcePasswordChange: row.force_password_change === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    schemaVersion: row.schema_version,
    accessRevision: row.access_revision,
  }
}

function mapGrant(row: RawGrantRow): UserPermissionGrantRecord {
  return {
    userId: row.user_id,
    permission: row.permission,
    grantedByUserId: row.granted_by_user_id,
    grantedAt: row.granted_at,
  }
}

function mapAccessSnapshot(rows: ReadonlyArray<RawAccessSnapshotRow>): UserAccessSnapshot {
  const first = rows[0]
  if (first === undefined) throw new Error('cannot materialize an empty user access snapshot')
  return {
    user: mapUser(first),
    grants: rows.flatMap((row) =>
      row.grant_user_id === null || row.grant_permission === null || row.grant_granted_at === null
        ? []
        : [
            mapGrant({
              user_id: row.grant_user_id,
              permission: row.grant_permission,
              granted_by_user_id: row.grant_granted_by_user_id,
              granted_at: row.grant_granted_at,
            }),
          ],
    ),
  }
}

function changesOf(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}
