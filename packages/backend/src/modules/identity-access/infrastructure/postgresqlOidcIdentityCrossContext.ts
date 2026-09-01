import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Permission, Role, UserIdentity } from '@agent-workflow/shared'
import {
  authLoginPolicy,
  oidcProviders,
  userAccessAudit,
  userIdentities,
  userPermissionGrants,
  users,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TransactionScope } from '@/platform/persistence/transactionScope'
import { ConflictError, NotFoundError } from '@/util/errors'
import { initialGrantsForRole } from '../domain/initialGrants'
import {
  mapOidcEmailConstraint,
  syncOidcProfileTransaction,
} from '../application/commands/syncOidcProfile'
import type { UserAccessAuditRecord } from '../application/ports/userAccessAuditRepository'
import type {
  ConditionalUserUpdate,
  InsertManagedUserRecord,
  OidcProfileIdentityRecord,
  OidcProfileIdentityUpdate,
  OidcProfileSelectorRecord,
  UserAccessRecord,
  UserPermissionGrantRecord,
} from '../application/ports/userAccessRepository'
import type { UserAccessTransaction } from '../application/ports/userAccessTransaction'
import type {
  CreateOidcIdentityInput,
  OidcIdentityOperations,
  OidcIdentityProfileAccess,
  OidcIdentityRecord,
  PostgresqlIdentityAccessCrossContextBindings,
} from '../application/ports/oidcIdentityCrossContext'
import type { InitialUserAccessProvision } from '../public/participants'
import { UserAccessError } from '../public/types'

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

type PendingOperation =
  | { readonly kind: 'insert-user'; readonly record: InsertManagedUserRecord }
  | { readonly kind: 'activate-user'; readonly userId: string; readonly now: number }
  | { readonly kind: 'insert-identity'; readonly record: OidcIdentityRecord }
  | { readonly kind: 'update-identity'; readonly update: OidcProfileIdentityUpdate }
  | { readonly kind: 'update-user'; readonly update: ConditionalUserUpdate }
  | { readonly kind: 'insert-grant'; readonly record: UserPermissionGrantRecord }
  | { readonly kind: 'append-audit'; readonly record: UserAccessAuditRecord }

interface LoadedOidcState {
  readonly users: ReadonlyArray<UserAccessRecord>
  readonly identity: OidcProfileIdentityRecord | null
  readonly selectors: OidcProfileSelectorRecord | null
}

interface ScopeClaim {
  readonly context: PostgresqlOidcTransactionContext
  open: boolean
}

const scopeClaims = new WeakMap<TransactionScope, ScopeClaim>()

function identityKey(providerId: string, subject: string): string {
  return `${providerId}\u0000${subject}`
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
    status: row.status,
    forcePasswordChange: row.forcePasswordChange,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
    schemaVersion: row.schemaVersion,
    accessRevision: row.accessRevision,
  }
}

class PostgresqlOidcTransactionContext implements UserAccessTransaction {
  readonly pending: PendingOperation[] = []
  private readonly users = new Map<string, UserAccessRecord>()
  private readonly usernames = new Map<string, string>()
  private readonly emails = new Map<string, string>()
  private readonly identities = new Map<string, OidcProfileIdentityRecord>()

  constructor(
    state: LoadedOidcState,
    private readonly providerId: string,
    subject: string,
    private readonly selectors: OidcProfileSelectorRecord | null,
  ) {
    for (const user of state.users) this.storeUser(user)
    if (state.identity !== null) {
      this.identities.set(identityKey(providerId, subject), state.identity)
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

  findUser(id: string): UserAccessRecord | null {
    return this.users.get(id) ?? null
  }

  findUserByUsername(username: string): UserAccessRecord | null {
    const id = this.usernames.get(username)
    return id === undefined ? null : (this.users.get(id) ?? null)
  }

  findUserByEmail(email: string): UserAccessRecord | null {
    const id = this.emails.get(email)
    return id === undefined ? null : (this.users.get(id) ?? null)
  }

  findOidcProfileIdentity(providerId: string, subject: string): OidcProfileIdentityRecord | null {
    return this.identities.get(identityKey(providerId, subject)) ?? null
  }

  findOidcProfileSelectors(providerId: string): OidcProfileSelectorRecord | null {
    return providerId === this.providerId ? this.selectors : null
  }

  updateOidcProfileIdentity(update: OidcProfileIdentityUpdate): void {
    for (const [key, identity] of this.identities) {
      if (identity.id !== update.id) continue
      this.identities.set(key, {
        ...identity,
        ...(update.email === undefined ? {} : { email: update.email }),
        ...(update.emailVerified === undefined ? {} : { emailVerified: update.emailVerified }),
        ...(update.preferredSnapshot === undefined
          ? {}
          : { preferredSnapshot: update.preferredSnapshot }),
      })
      this.pending.push({ kind: 'update-identity', update })
      return
    }
    throw new UserAccessError('not-found', 'identity-not-found', 'OIDC identity was not found')
  }

  listGrants(_userId: string): ReadonlyArray<UserPermissionGrantRecord> {
    return []
  }

  countOtherActiveAccessAdministrators(_excludeId: string, _systemUserId: string): number {
    throw new Error('OIDC cross-context scope does not support administrator census')
  }

  insertUser(record: InsertManagedUserRecord): void {
    if (this.users.has(record.id) || this.usernames.has(record.username)) {
      throw new UserAccessError('conflict', 'username-taken', 'username already exists')
    }
    if (record.email !== null && this.emails.has(record.email)) {
      throw new UserAccessError(
        'conflict',
        'oidc-email-conflict',
        'the identity provider email already belongs to another user',
      )
    }
    this.storeUser(record)
    this.pending.push({ kind: 'insert-user', record })
  }

  updateUserConditional(update: ConditionalUserUpdate): boolean {
    const current = this.users.get(update.id)
    if (current === undefined) return false
    if (update.accessChanged && current.accessRevision !== update.expectedAccessRevision)
      return false
    const next: UserAccessRecord = {
      ...current,
      displayName: update.values.displayName ?? current.displayName,
      gitName: update.values.gitName ?? current.gitName,
      email: Object.prototype.hasOwnProperty.call(update.values, 'email')
        ? (update.values.email ?? null)
        : current.email,
      role: update.values.role ?? current.role,
      status: update.values.status ?? current.status,
      forcePasswordChange: update.values.forcePasswordChange ?? current.forcePasswordChange,
      updatedAt: update.values.updatedAt ?? current.updatedAt,
      accessRevision: update.values.accessRevision ?? current.accessRevision,
    }
    this.storeUser(next)
    this.pending.push({ kind: 'update-user', update })
    return true
  }

  deleteGrantValue(_userId: string, _permission: string): void {
    throw new Error('OIDC cross-context scope does not support grant deletion')
  }

  deleteGrant(_userId: string, _permission: Permission): void {
    throw new Error('OIDC cross-context scope does not support grant deletion')
  }

  insertGrant(record: UserPermissionGrantRecord): void {
    this.pending.push({ kind: 'insert-grant', record })
  }

  transitionDisabledOwner(_userId: string, _now: number): void {
    throw new Error('OIDC cross-context scope does not support owner transitions')
  }

  appendAudit(record: UserAccessAuditRecord): void {
    this.pending.push({ kind: 'append-audit', record })
  }

  insertInitialUserAccess(provision: InitialUserAccessProvision): void {
    this.insertUser({
      ...provision.user,
      updatedAt: provision.user.createdAt,
      lastLoginAt: null,
      schemaVersion: 1,
      accessRevision: 0,
    })
    const grants = initialGrantsForRole(provision.user.role)
    for (const permission of grants) {
      this.insertGrant({
        userId: provision.user.id,
        permission,
        grantedByUserId: null,
        grantedAt: provision.user.createdAt,
      })
    }
    this.appendAudit({
      ...provision.audit,
      targetUserId: provision.user.id,
      correlationId: provision.audit.operationId,
      beforeRole: provision.user.role,
      afterRole: provision.user.role,
      addedPermissions: grants,
      removedPermissions: [],
      accessRevision: 0,
      createdAt: provision.user.createdAt,
    })
  }

  activateUser(userId: string, now: number): void {
    const current = this.users.get(userId)
    if (current === undefined) {
      throw new UserAccessError('not-found', 'user-not-found', 'OIDC user was not found')
    }
    this.storeUser({ ...current, status: 'active', updatedAt: now })
    this.pending.push({ kind: 'activate-user', userId, now })
  }

  insertIdentity(record: OidcIdentityRecord): void {
    const key = identityKey(record.providerId, record.subject)
    const existing = this.identities.get(key)
    if (existing !== undefined) {
      throw new ConflictError(
        'identity-already-linked',
        `provider/${record.providerId} subject/${record.subject} is already linked to user ${existing.userId}`,
      )
    }
    this.identities.set(key, {
      id: record.id,
      userId: record.userId,
      email: record.email,
      emailVerified: record.emailVerified === 1,
      preferredSnapshot: record.preferredSnapshot,
    })
    this.pending.push({ kind: 'insert-identity', record })
  }
}

function claim(scope: TransactionScope): PostgresqlOidcTransactionContext {
  const current = scopeClaims.get(scope)
  if (current === undefined || !current.open) throw new Error('transaction scope is not live')
  return current.context
}

function withScope(
  context: PostgresqlOidcTransactionContext,
  body: (scope: TransactionScope) => void,
): void {
  const scope = Object.freeze({ transactionId: ulid() }) as TransactionScope
  const current: ScopeClaim = { context, open: true }
  scopeClaims.set(scope, current)
  try {
    const result: unknown = body(scope)
    if (result !== undefined) throw new Error('transaction scope callback must not return a value')
  } finally {
    current.open = false
  }
}

export function createPostgresqlIdentityAccessCrossContextBindings(): PostgresqlIdentityAccessCrossContextBindings {
  const bindings: PostgresqlIdentityAccessCrossContextBindings = {
    initialUserAccess: Object.freeze({
      forTransaction(transactionScope: TransactionScope) {
        const context = claim(transactionScope)
        return Object.freeze({
          insert(provision: InitialUserAccessProvision): void {
            context.insertInitialUserAccess(provision)
          },
        })
      },
    }),
    syncOidcProfileInTransaction(transactionScope, command, now = Date.now()) {
      try {
        return syncOidcProfileTransaction(claim(transactionScope), command, {
          now,
          operationId: ulid(),
          auditId: ulid,
        })
      } catch (error) {
        throw mapOidcEmailConstraint(error)
      }
    },
  }
  return Object.freeze(bindings)
}

function hasProfileSnapshot(input: CreateOidcIdentityInput): boolean {
  return (
    input.expectedSubjectClaim !== undefined ||
    input.expectedUsernameClaim !== undefined ||
    input.expectedGitNameClaim !== undefined ||
    input.expectedEmailClaim !== undefined
  )
}

function assertProfileNames(
  input: CreateOidcIdentityInput,
): asserts input is CreateOidcIdentityInput & {
  readonly displayName: string
  readonly gitName: string
} {
  if (input.displayName === undefined || input.gitName === undefined) {
    throw new ConflictError(
      'oidc-profile-names-missing',
      'callback identity is missing resolved OIDC profile names',
    )
  }
}

function profileCommand(input: CreateOidcIdentityInput) {
  assertProfileNames(input)
  return {
    providerId: input.providerId,
    subject: input.subject,
    userId: input.userId,
    displayName: input.displayName,
    gitName: input.gitName,
    email: input.email,
    emailVerified: input.emailVerified,
    ...(input.expectedSubjectClaim !== undefined
      ? { expectedSubjectClaim: input.expectedSubjectClaim }
      : {}),
    ...(input.expectedUsernameClaim !== undefined
      ? { expectedUsernameClaim: input.expectedUsernameClaim }
      : {}),
    ...(input.expectedGitNameClaim !== undefined
      ? { expectedGitNameClaim: input.expectedGitNameClaim }
      : {}),
    ...(input.expectedEmailClaim !== undefined
      ? { expectedEmailClaim: input.expectedEmailClaim }
      : {}),
  }
}

async function loadState(
  transaction: PostgresqlTransaction,
  input: CreateOidcIdentityInput,
): Promise<LoadedOidcState> {
  const loadedUsers = new Map<string, UserAccessRecord>()
  const byId = await transaction
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .get()
  if (byId !== undefined) loadedUsers.set(byId.id, mapUser(byId))
  if (input.email !== null) {
    const byEmail = await transaction
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
      .get()
    if (byEmail !== undefined) loadedUsers.set(byEmail.id, mapUser(byEmail))
  }
  const identity = await transaction
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
        eq(userIdentities.providerId, input.providerId),
        eq(userIdentities.subject, input.subject),
      ),
    )
    .limit(1)
    .get()
  const selectors = hasProfileSnapshot(input)
    ? await transaction
        .select({
          subjectClaim: oidcProviders.subjectClaim,
          usernameClaim: oidcProviders.usernameClaim,
          gitNameClaim: oidcProviders.gitNameClaim,
          emailClaim: oidcProviders.emailClaim,
        })
        .from(oidcProviders)
        .where(eq(oidcProviders.id, input.providerId))
        .limit(1)
        .get()
    : null
  return {
    users: [...loadedUsers.values()],
    identity:
      identity === undefined ? null : { ...identity, emailVerified: identity.emailVerified === 1 },
    selectors: selectors ?? null,
  }
}

function identityRecord(input: CreateOidcIdentityInput): OidcIdentityRecord {
  return {
    id: ulid(),
    userId: input.userId,
    providerId: input.providerId,
    subject: input.subject,
    email: input.email,
    emailVerified: input.emailVerified ? 1 : 0,
    preferredSnapshot: input.preferredSnapshot ?? null,
    linkedAt: input.now ?? Date.now(),
  }
}

async function flush(
  transaction: PostgresqlTransaction,
  operations: ReadonlyArray<PendingOperation>,
): Promise<void> {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'insert-user':
        await transaction.insert(users).values(operation.record).run()
        break
      case 'activate-user':
        await transaction
          .update(users)
          .set({ status: 'active', updatedAt: operation.now })
          .where(eq(users.id, operation.userId))
          .run()
        break
      case 'insert-identity':
        await transaction.insert(userIdentities).values(operation.record).run()
        break
      case 'update-identity': {
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
      case 'update-user': {
        const values: Partial<typeof users.$inferInsert> = {}
        if (operation.update.values.displayName !== undefined) {
          values.displayName = operation.update.values.displayName
        }
        if (operation.update.values.gitName !== undefined) {
          values.gitName = operation.update.values.gitName
        }
        if (Object.prototype.hasOwnProperty.call(operation.update.values, 'email')) {
          values.email = operation.update.values.email ?? null
        }
        if (operation.update.values.updatedAt !== undefined) {
          values.updatedAt = operation.update.values.updatedAt
        }
        await transaction.update(users).set(values).where(eq(users.id, operation.update.id)).run()
        break
      }
      case 'insert-grant':
        await transaction.insert(userPermissionGrants).values(operation.record).run()
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

function isRetryable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (code === '40001' || code === '40P01') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

function isIdentityUnique(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      readonly code?: unknown
      readonly constraint?: unknown
      readonly message?: unknown
      readonly cause?: unknown
    }
    if (
      candidate.code === '23505' &&
      (candidate.constraint === 'user_identities_provider_subject_unique' ||
        /user_identities_provider_subject_unique/i.test(String(candidate.message ?? '')))
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
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
      if (attempt < 2 && isRetryable(error)) continue
      throw error
    }
  }
}

function mapIdentity(row: {
  readonly identity: typeof userIdentities.$inferSelect
  readonly provider: typeof oidcProviders.$inferSelect | null
}): UserIdentity {
  return {
    id: row.identity.id,
    userId: row.identity.userId,
    providerId: row.identity.providerId,
    providerSlug: row.provider?.slug,
    providerDisplayName: row.provider?.displayName,
    subject: row.identity.subject,
    email: row.identity.email,
    emailVerified: row.identity.emailVerified === 1,
    linkedAt: row.identity.linkedAt,
  }
}

export function composePostgresqlOidcIdentityOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly identityAccess: OidcIdentityProfileAccess
  readonly onIdentityDeleted?: () => void | Promise<void>
}): OidcIdentityOperations {
  const { db, identityAccess } = input

  const writeIdentity = async (
    identityInput: CreateOidcIdentityInput,
    beforeInsert?: (context: PostgresqlOidcTransactionContext, scope: TransactionScope) => void,
  ): Promise<OidcIdentityRecord> => {
    try {
      return await serializable(db, async (transaction) => {
        const state = await loadState(transaction, identityInput)
        const context = new PostgresqlOidcTransactionContext(
          state,
          identityInput.providerId,
          identityInput.subject,
          state.selectors,
        )
        const record = identityRecord(identityInput)
        withScope(context, (scope) => {
          beforeInsert?.(context, scope)
          context.insertIdentity(record)
          if (hasProfileSnapshot(identityInput)) {
            identityAccess.syncOidcProfileInTransaction(
              scope,
              profileCommand(identityInput),
              identityInput.now ?? Date.now(),
            )
          }
        })
        await flush(transaction, context.pending)
        return record
      })
    } catch (error) {
      if (isIdentityUnique(error)) {
        throw new ConflictError(
          'identity-already-linked',
          `provider/${identityInput.providerId} subject/${identityInput.subject} is already linked`,
        )
      }
      throw identityAccessDomainError(identityAccess.mapOidcEmailConstraint(error))
    }
  }

  const operations: OidcIdentityOperations = {
    async listIdentitiesForUser(userId) {
      const rows = await db
        .select({ identity: userIdentities, provider: oidcProviders })
        .from(userIdentities)
        .leftJoin(oidcProviders, eq(oidcProviders.id, userIdentities.providerId))
        .where(eq(userIdentities.userId, userId))
      return rows.map(mapIdentity)
    },
    async findByProviderSubject(providerId, subject) {
      const row = await db
        .select()
        .from(userIdentities)
        .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.subject, subject)))
        .limit(1)
        .get()
      return row ?? null
    },
    async createIdentity(identityInput) {
      return await writeIdentity(identityInput)
    },
    async createUserWithIdentity(userInput) {
      const now = userInput.now ?? Date.now()
      const userId = ulid()
      const identityInput = { ...userInput.identity, userId, now }
      try {
        return await serializable(db, async (transaction) => {
          const policy = await transaction
            .select({ oidcDefaultRole: authLoginPolicy.oidcDefaultRole })
            .from(authLoginPolicy)
            .where(eq(authLoginPolicy.id, 'global'))
            .get()
          if (policy === undefined) throw new Error('authentication policy singleton is missing')
          const state = await loadState(transaction, identityInput)
          const usernameOwner = await transaction
            .select()
            .from(users)
            .where(eq(users.username, userInput.username))
            .limit(1)
            .get()
          const usersForScope =
            usernameOwner === undefined || state.users.some((row) => row.id === usernameOwner.id)
              ? state.users
              : [...state.users, mapUser(usernameOwner)]
          const context = new PostgresqlOidcTransactionContext(
            { ...state, users: usersForScope },
            identityInput.providerId,
            identityInput.subject,
            state.selectors,
          )
          const record = identityRecord(identityInput)
          withScope(context, (scope) => {
            identityAccess.initialUserAccess.forTransaction(scope).insert({
              user: {
                id: userId,
                username: userInput.username,
                email: userInput.email ?? null,
                displayName: userInput.displayName,
                gitName: userInput.gitName,
                passwordHash: null,
                role: policy.oidcDefaultRole,
                status: 'active',
                forcePasswordChange: false,
                createdBy: null,
                createdAt: now,
              },
              audit: {
                id: ulid(),
                actorUserId: null,
                actorKind: 'system',
                operationId: ulid(),
              },
            })
            context.insertIdentity(record)
            if (hasProfileSnapshot(identityInput)) {
              identityAccess.syncOidcProfileInTransaction(scope, profileCommand(identityInput), now)
            }
          })
          await flush(transaction, context.pending)
          return { userId }
        })
      } catch (error) {
        if (isIdentityUnique(error)) {
          throw new ConflictError(
            'identity-already-linked',
            `provider/${identityInput.providerId} subject/${identityInput.subject} is already linked`,
          )
        }
        throw identityAccessDomainError(identityAccess.mapOidcEmailConstraint(error))
      }
    },
    async bindInvitedUserWithIdentity(bindInput) {
      const now = bindInput.now ?? Date.now()
      const identityInput = { ...bindInput.identity, userId: bindInput.userId, now }
      await writeIdentity(identityInput, (context) => context.activateUser(bindInput.userId, now))
    },
    async syncPreferredSnapshot(profileInput) {
      try {
        return await identityAccess.syncOidcProfile.execute({
          providerId: profileInput.providerId,
          subject: profileInput.subject,
          userId: profileInput.userId,
          displayName: profileInput.displayName,
          gitName: profileInput.gitName,
          email: profileInput.email ?? null,
          emailVerified: profileInput.emailVerified,
          ...(profileInput.expectedSubjectClaim !== undefined
            ? { expectedSubjectClaim: profileInput.expectedSubjectClaim }
            : {}),
          ...(profileInput.expectedUsernameClaim !== undefined
            ? { expectedUsernameClaim: profileInput.expectedUsernameClaim }
            : {}),
          ...(profileInput.expectedGitNameClaim !== undefined
            ? { expectedGitNameClaim: profileInput.expectedGitNameClaim }
            : {}),
          ...(profileInput.expectedEmailClaim !== undefined
            ? { expectedEmailClaim: profileInput.expectedEmailClaim }
            : {}),
        })
      } catch (error) {
        throw identityAccessDomainError(error)
      }
    },
    async unlinkIdentity(identityId) {
      const deleted = await serializable(db, async (transaction) => {
        const row = await transaction
          .select({ id: userIdentities.id })
          .from(userIdentities)
          .where(eq(userIdentities.id, identityId))
          .limit(1)
          .get()
        if (row === undefined) return false
        await transaction.delete(userIdentities).where(eq(userIdentities.id, identityId)).run()
        return true
      })
      if (!deleted) {
        throw new NotFoundError('identity-not-found', `identity ${identityId} not found`)
      }
      await input.onIdentityDeleted?.()
    },
  }
  return Object.freeze(operations)
}

function identityAccessDomainError(error: unknown): unknown {
  if (!(error instanceof UserAccessError)) return error
  if (error.kind === 'not-found') {
    return new NotFoundError(error.code, error.message, error.details)
  }
  return new ConflictError(error.code, error.message, error.details)
}
