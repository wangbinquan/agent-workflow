import { and, eq, sql } from 'drizzle-orm'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import { transitionOwnerRuntimeTestsInTx } from '@/services/mcpRuntimeTestTransitions'
import type {
  ConditionalUserUpdate,
  InsertManagedUserRecord,
  UserAccessReadRepository,
  UserAccessRecord,
  UserPermissionGrantRecord,
} from '../application/ports/userAccessRepository'
import type {
  UserAccessTransaction,
  UserAccessTransactionRunner,
} from '../application/ports/userAccessTransaction'
import type { UserAccessAuditRecord } from '../application/ports/userAccessAuditRepository'
import { appendUserAccessAudit } from './sqliteUserAccessAuditRepository'

interface RawUserAccessRow {
  id: string
  username: string
  email: string | null
  display_name: string
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

const USER_SELECT = sql.raw(`
  SELECT id, username, email, display_name, password_hash, role, status,
         force_password_change, created_by, created_at, updated_at,
         last_login_at, schema_version, access_revision
  FROM users
`)

export class SQLiteUserAccessRepository implements UserAccessReadRepository {
  constructor(private readonly db: DbClient) {}

  async findUser(id: string): Promise<UserAccessRecord | null> {
    const rows = (await this.db.all(
      sql`${USER_SELECT} WHERE id = ${id} LIMIT 1`,
    )) as RawUserAccessRow[]
    return rows[0] === undefined ? null : mapUser(rows[0])
  }

  async findUserByUsername(username: string): Promise<UserAccessRecord | null> {
    const rows = (await this.db.all(
      sql`${USER_SELECT} WHERE username = ${username} LIMIT 1`,
    )) as RawUserAccessRow[]
    return rows[0] === undefined ? null : mapUser(rows[0])
  }

  async listUsers(): Promise<ReadonlyArray<UserAccessRecord>> {
    const rows = (await this.db.all(
      sql`${USER_SELECT} ORDER BY created_at, id`,
    )) as RawUserAccessRow[]
    return rows.map(mapUser)
  }

  async listGrants(
    userIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<UserPermissionGrantRecord>> {
    if (userIds.length === 0) return []
    const rows = (await this.db.all(sql`
      SELECT user_id, permission, granted_by_user_id, granted_at
      FROM user_permission_grants
      WHERE user_id IN (${sql.join(
        userIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      ORDER BY user_id, permission
    `)) as RawGrantRow[]
    return rows.map(mapGrant)
  }
}

export class SQLiteUserAccessTransactionRunner implements UserAccessTransactionRunner {
  constructor(private readonly db: DbClient) {}

  run<T>(body: (transaction: UserAccessTransaction) => NotPromise<T>): T {
    return dbTxSync(this.db, (transaction) => body(new SQLiteUserAccessTransaction(transaction)))
  }
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

function changesOf(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}
