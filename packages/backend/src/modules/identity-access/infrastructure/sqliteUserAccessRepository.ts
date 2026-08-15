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
  UserAccessSnapshot,
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

interface RawAccessSnapshotRow extends RawUserAccessRow {
  grant_user_id: string | null
  grant_permission: string | null
  grant_granted_by_user_id: string | null
  grant_granted_at: number | null
}

const USER_SELECT = sql.raw(`
  SELECT id, username, email, display_name, password_hash, role, status,
         force_password_change, created_by, created_at, updated_at,
         last_login_at, schema_version, access_revision
  FROM users
`)

const ACCESS_SNAPSHOT_SELECT = sql.raw(`
  SELECT u.id, u.username, u.email, u.display_name, u.password_hash,
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

export class SQLiteUserAccessRepository implements UserAccessReadRepository {
  constructor(private readonly db: DbClient) {}

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

export class SQLiteUserAccessTransactionRunner implements UserAccessTransactionRunner {
  constructor(private readonly db: DbClient) {}

  run<T>(body: (transaction: UserAccessTransaction) => NotPromise<T>): T {
    return dbTxSync(this.db, (transaction) => body(new SQLiteUserAccessTransaction(transaction)))
  }
}

export interface InitialUserAccessProvision {
  readonly user: InsertManagedUserRecord
  readonly audit: UserAccessAuditRecord
}

/** Exact transaction participant for cross-context account provisioning.
 * Bootstrap/OIDC keep their adjacent writes in the same SQLite transaction,
 * while the identity-access infrastructure remains the sole role/revision and
 * access-audit writer. */
export function insertInitialUserAccessInTransaction(
  transaction: DbTxSync,
  provision: InitialUserAccessProvision,
): void {
  const participant = new SQLiteUserAccessTransaction(transaction)
  participant.insertUser(provision.user)
  participant.appendAudit(provision.audit)
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
