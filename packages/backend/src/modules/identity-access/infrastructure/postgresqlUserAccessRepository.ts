// RFC-349 — PostgreSQL identity-access persistence. Application code receives
// only Promise ports and a synchronous pure-decision snapshot; the reserved
// connection, transaction isolation and generation fence stay infrastructure-
// private.

import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'

import { SYSTEM_USER_ID } from '@/auth/actor'
import {
  mcpRuntimeTestSessions,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPermissionGrants,
  users,
} from '@/db/schema'
import type { NotPromise } from '@/db/txSync'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { UserAccessError, type ManagedUserStatus } from '../public/types'
import type { UserAccessAuditRecord } from '../application/ports/userAccessAuditRepository'
import type {
  AuthorityFenceRecord,
  ConditionalUserUpdate,
  InsertManagedUserRecord,
  OidcProfileIdentityRecord,
  OidcProfileIdentityUpdate,
  OidcProfileSelectorRecord,
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

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function identityKey(providerId: string, subject: string): string {
  return `${providerId}\u0000${subject}`
}

function grantKey(userId: string, permission: string): string {
  return `${userId}\u0000${permission}`
}

function mutationChanges(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
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

/**
 * PostgreSQL cannot satisfy a synchronous WS frame gate with a network query.
 * The cache is warmed by the same async authority read that mints a connection
 * and refreshed only after a local mutation commits. A miss is null, so the
 * existing transport gate fails closed rather than sending with stale facts.
 * RFC-349 V1 has one daemon generation; distributed invalidation remains out
 * of scope until multi-daemon support exists.
 */
export class PostgresqlAuthorityFenceCache implements UserAccessFenceReader {
  private readonly records = new Map<string, AuthorityFenceRecord>()

  readAuthorityFence(id: string): AuthorityFenceRecord | null {
    return this.records.get(id) ?? null
  }

  remember(user: Pick<UserAccessRecord, 'id' | 'status' | 'accessRevision'>): void {
    this.records.set(user.id, {
      status: user.status,
      accessRevision: user.accessRevision,
    })
  }
}

export class PostgresqlUserAccessRepository
  implements UserAccessReadRepository, UserAccessFenceReader
{
  constructor(
    private readonly db: PostgresqlDatabaseClient,
    private readonly fenceCache = new PostgresqlAuthorityFenceCache(),
  ) {}

  readAuthorityFence(id: string): AuthorityFenceRecord | null {
    return this.fenceCache.readAuthorityFence(id)
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
    const rows = await this.db
      .select({ user: users, grant: userPermissionGrants })
      .from(users)
      .leftJoin(userPermissionGrants, eq(userPermissionGrants.userId, users.id))
      .where(eq(users.id, id))
      .orderBy(asc(userPermissionGrants.permission))
      .all()
    const first = rows[0]
    if (first === undefined) return null
    const snapshot = {
      user: mapUser(first.user),
      grants: rows.flatMap((row) => (row.grant === null ? [] : [mapGrant(row.grant)])),
    }
    this.fenceCache.remember(snapshot.user)
    return snapshot
  }

  async listAccessSnapshots(): Promise<ReadonlyArray<UserAccessSnapshot>> {
    const rows = await this.db
      .select({ user: users, grant: userPermissionGrants })
      .from(users)
      .leftJoin(userPermissionGrants, eq(userPermissionGrants.userId, users.id))
      .orderBy(asc(users.createdAt), asc(users.id), asc(userPermissionGrants.permission))
      .all()
    if (rows.length === 0) return []
    const grouped = new Map<string, UserAccessSnapshot>()
    for (const row of rows) {
      let current = grouped.get(row.user.id) ?? {
        user: mapUser(row.user),
        grants: [],
      }
      if (row.grant !== null) {
        current = { ...current, grants: [...current.grants, mapGrant(row.grant)] }
      }
      grouped.set(row.user.id, current)
    }
    return [...grouped.values()].map((snapshot) => {
      this.fenceCache.remember(snapshot.user)
      return snapshot
    })
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

type BufferedOperation =
  | { readonly kind: 'insert-user'; readonly record: InsertManagedUserRecord }
  | { readonly kind: 'update-user'; readonly update: ConditionalUserUpdate }
  | { readonly kind: 'update-oidc-identity'; readonly update: OidcProfileIdentityUpdate }
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

interface LoadedUserAccessState {
  readonly users: ReadonlyArray<UserAccessRecord>
  readonly grants: ReadonlyArray<UserPermissionGrantRecord>
  readonly oidcIdentity: OidcProfileIdentityRecord | null
  readonly oidcSelectors: OidcProfileSelectorRecord | null
}

class BufferedUserAccessTransaction implements UserAccessTransaction {
  readonly operations: BufferedOperation[] = []
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
    for (const grant of state.grants)
      this.grants.set(grantKey(grant.userId, grant.permission), grant)
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
      if (user.id === excludeId || user.id === systemUserId || user.status !== 'active')
        return false
      const additionalPermissions = normalizeStoredAdditionalPermissions({
        role: user.role,
        additionalPermissions: this.listGrants(user.id).map((grant) => grant.permission),
      }).additionalPermissions
      return resolveEffectiveAccountPermissions({
        role: user.role,
        additionalPermissions,
      }).has('users:write')
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
    if (update.accessChanged && current.accessRevision !== update.expectedAccessRevision)
      return false
    const next = { ...current, ...update.values }
    this.storeUser(next)
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

export class PostgresqlUserAccessTransactionRunner implements UserAccessTransactionRunner {
  constructor(
    private readonly db: PostgresqlDatabaseClient,
    private readonly fenceCache: PostgresqlAuthorityFenceCache,
  ) {}

  async run<T>(
    readSet: UserAccessTransactionReadSet,
    body: (transaction: UserAccessTransaction) => NotPromise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const committed = await this.db.transaction(async (transaction) => {
          await transaction.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
          const state = await loadState(transaction, readSet)
          const buffered = new BufferedUserAccessTransaction(readSet, state)
          const value = body(buffered)
          await persistOperations(transaction, buffered.operations)
          return { value, fenceRecords: buffered.committedFenceRecords() }
        })
        for (const user of committed.fenceRecords) this.fenceCache.remember(user)
        return committed.value
      } catch (error) {
        if (attempt < 2 && isRetryablePostgresqlTransactionError(error)) continue
        throw mapPostgresqlUserAccessError(error, readSet.operation)
      }
    }
  }
}

async function loadState(
  transaction: PostgresqlTransaction,
  readSet: UserAccessTransactionReadSet,
): Promise<LoadedUserAccessState> {
  const loadedUsers = new Map<string, UserAccessRecord>()
  const loadRows = async (condition: SQL<unknown>): Promise<void> => {
    const rows = await transaction.select().from(users).where(condition).all()
    for (const row of rows) loadedUsers.set(row.id, mapUser(row))
  }

  const userIds = [...new Set(readSet.userIds ?? [])]
  if (userIds.length > 0) await loadRows(inArray(users.id, userIds))
  const usernames = [...new Set(readSet.usernames ?? [])]
  if (usernames.length > 0) await loadRows(inArray(users.username, usernames))
  const emails = [...new Set(readSet.emails ?? [])]
  if (emails.length > 0) await loadRows(inArray(users.email, emails))
  if (readSet.activeAccessAdministrators === true) {
    await loadRows(eq(users.status, 'active'))
  }

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
          await transaction
            .select()
            .from(userPermissionGrants)
            .where(inArray(userPermissionGrants.userId, [...grantUserIds]))
            .all()
        ).map(mapGrant)

  let oidcIdentity: OidcProfileIdentityRecord | null = null
  if (readSet.oidcProfileIdentity !== undefined) {
    const row = await transaction
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
      .get()
    oidcIdentity =
      row === undefined
        ? null
        : {
            ...row,
            emailVerified: row.emailVerified === 1,
          }
  }

  let oidcSelectors: OidcProfileSelectorRecord | null = null
  if (readSet.oidcProfileSelectorsProviderId !== undefined) {
    const row = await transaction
      .select({
        subjectClaim: oidcProviders.subjectClaim,
        usernameClaim: oidcProviders.usernameClaim,
        gitNameClaim: oidcProviders.gitNameClaim,
        emailClaim: oidcProviders.emailClaim,
      })
      .from(oidcProviders)
      .where(eq(oidcProviders.id, readSet.oidcProfileSelectorsProviderId))
      .limit(1)
      .get()
    oidcSelectors = row ?? null
  }

  return { users: [...loadedUsers.values()], grants, oidcIdentity, oidcSelectors }
}

async function persistOperations(
  transaction: PostgresqlTransaction,
  operations: ReadonlyArray<BufferedOperation>,
): Promise<void> {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'insert-user':
        await transaction
          .insert(users)
          .values({
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
          .run()
        break
      case 'update-user': {
        const values: Partial<typeof users.$inferInsert> = {}
        if (operation.update.values.displayName !== undefined) {
          values.displayName = operation.update.values.displayName
        }
        if (operation.update.values.gitName !== undefined) {
          values.gitName = operation.update.values.gitName
        }
        if (Object.prototype.hasOwnProperty.call(operation.update.values, 'email')) {
          values.email = operation.update.values.email
        }
        if (operation.update.values.role !== undefined) values.role = operation.update.values.role
        if (operation.update.values.status !== undefined) {
          values.status = operation.update.values.status
        }
        if (operation.update.values.forcePasswordChange !== undefined) {
          values.forcePasswordChange = operation.update.values.forcePasswordChange
        }
        if (operation.update.values.accessRevision !== undefined) {
          values.accessRevision = operation.update.values.accessRevision
        }
        if (operation.update.values.updatedAt !== undefined) {
          values.updatedAt = operation.update.values.updatedAt
        }
        const result = await transaction
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
          .run()
        if (mutationChanges(result) !== 1) {
          throw new UserAccessError(
            'conflict',
            operation.update.accessChanged ? 'user-access-stale' : 'profile-update-conflict',
            operation.update.accessChanged ? 'user access changed' : 'profile changed',
          )
        }
        break
      }
      case 'update-oidc-identity': {
        const values: Partial<typeof userIdentities.$inferInsert> = {}
        if (operation.update.email !== undefined) values.email = operation.update.email
        if (operation.update.emailVerified !== undefined) {
          values.emailVerified = operation.update.emailVerified ? 1 : 0
        }
        if (operation.update.preferredSnapshot !== undefined) {
          values.preferredSnapshot = operation.update.preferredSnapshot
        }
        await transaction
          .update(userIdentities)
          .set(values)
          .where(eq(userIdentities.id, operation.update.id))
          .run()
        break
      }
      case 'delete-grant':
        await transaction
          .delete(userPermissionGrants)
          .where(
            and(
              eq(userPermissionGrants.userId, operation.userId),
              eq(userPermissionGrants.permission, operation.permission),
            ),
          )
          .run()
        break
      case 'insert-grant':
        await transaction.insert(userPermissionGrants).values(operation.record).run()
        break
      case 'transition-disabled-owner':
        await transaction
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
          .run()
        break
      case 'append-audit':
        await transaction
          .insert(userAccessAudit)
          .values({
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
          .run()
        break
    }
  }
}

function isRetryablePostgresqlTransactionError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (code === '40001' || code === '40P01') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

function mapPostgresqlUserAccessError(
  error: unknown,
  operation: UserAccessTransactionReadSet['operation'],
): unknown {
  if (error instanceof UserAccessError) return error
  let current: unknown = error
  let unique = false
  let constraint = ''
  let message = ''
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as {
      readonly code?: unknown
      readonly constraint?: unknown
      readonly message?: unknown
      readonly cause?: unknown
    }
    if (record.code === '23505') unique = true
    if (typeof record.constraint === 'string') constraint = record.constraint
    if (typeof record.message === 'string') message += ` ${record.message}`
    current = record.cause
  }
  if (!unique) return error
  if (constraint === 'users_username_unique' || /users_username_unique/i.test(message)) {
    return new UserAccessError('conflict', 'username-taken', 'username already exists')
  }
  if (constraint === 'users_email_unique' || /users_email_unique/i.test(message)) {
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
