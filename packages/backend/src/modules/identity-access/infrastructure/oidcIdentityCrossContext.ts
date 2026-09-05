// RFC-359 W4-D8 —— OIDC 身份关联（建号 / 绑定 / 关联 / 解绑）：一份实现，两个 provider 共用。
//
// 形态沿用原 PostgreSQL 适配器：一笔 `session.serializable` 里先装载读集（用户 by id / email / username、
// 已关联身份、provider 的 claim 选择器），在内存里的 `OidcTransactionContext`（一个 `UserAccessTransaction`
// 参与者 + 身份行暂存）上跑同步决策——初始账户 / 默认授权 / 审计、身份行、以及 identity-access 自己的
// `syncOidcProfileTransaction`——最后按顺序回放到库。RFC-349 期这里经「TransactionScope 认领」绕道运行时的
// 公共面再回到 infrastructure；OIDC 本就是 identity-access 的 infrastructure，直接用同一份写模型。
//
// 与旧 SQLite 版的语义对齐点（取两者中更完整的一边）：用户名冲突不再漏成裸驱动错误而是 `username-taken`；
// 绑定邀请用户时用户不存在报 `user-not-found`；解绑在一笔事务里判存在再删。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserIdentity } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import { authLoginPolicy, oidcProviders, userIdentities, users } from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError } from '@/util/errors'
import { syncOidcProfileTransaction } from '../application/commands/syncOidcProfile'
import type {
  CreateOidcIdentityInput,
  OidcIdentityOperations,
  OidcIdentityProfileAccess,
  OidcIdentityRecord,
} from '../application/ports/oidcIdentityCrossContext'
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
import { UserAccessError, type ManagedUserStatus } from '../public/types'
import {
  mapUserAccessError,
  persistUserAccessOperations,
  stageInitialUserAccess,
  type UserAccessOperation,
} from './userAccessPersistence'

export interface OidcIdentityCompositionInput {
  readonly db: ProviderNeutralDatabase
  /** 缺席时只有读与解绑可用；需要账户参与者的路径报 `identity-access-runtime-not-composed`。 */
  readonly identityAccess?: OidcIdentityProfileAccess
  readonly onIdentityDeleted?: () => void | Promise<void>
}

interface LoadedOidcState {
  readonly users: ReadonlyArray<UserAccessRecord>
  readonly identity: OidcProfileIdentityRecord | null
  readonly selectors: OidcProfileSelectorRecord | null
}

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
    role: row.role,
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

/** OIDC 写事务的内存参与者：账户面按装载的读集回答，身份行在这里暂存，落库统一经 persistUserAccessOperations。 */
class OidcTransactionContext implements UserAccessTransaction {
  readonly operations: UserAccessOperation[] = []
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
      this.operations.push({ kind: 'update-oidc-identity', update })
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
    this.operations.push({ kind: 'insert-user', record })
  }

  updateUserConditional(update: ConditionalUserUpdate): boolean {
    const current = this.users.get(update.id)
    if (current === undefined) return false
    if (update.accessChanged && current.accessRevision !== update.expectedAccessRevision) {
      return false
    }
    this.storeUser({ ...current, ...update.values })
    this.operations.push({ kind: 'update-user', update })
    return true
  }

  deleteGrantValue(_userId: string, _permission: string): void {
    throw new Error('OIDC cross-context scope does not support grant deletion')
  }

  deleteGrant(_userId: string, _permission: string): void {
    throw new Error('OIDC cross-context scope does not support grant deletion')
  }

  insertGrant(record: UserPermissionGrantRecord): void {
    this.operations.push({
      kind: 'insert-grant',
      record: { ...record, permission: record.permission as never },
    })
  }

  transitionDisabledOwner(_userId: string, _now: number): void {
    throw new Error('OIDC cross-context scope does not support owner transitions')
  }

  appendAudit(record: UserAccessAuditRecord): void {
    this.operations.push({ kind: 'append-audit', record })
  }

  activateUser(userId: string, now: number): void {
    const current = this.users.get(userId)
    if (current === undefined) {
      throw new UserAccessError('not-found', 'user-not-found', 'OIDC user was not found')
    }
    this.storeUser({ ...current, status: 'active', updatedAt: now })
    this.operations.push({ kind: 'activate-user', userId, now })
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
    this.operations.push({ kind: 'insert-identity', record })
  }
}

function assertProviderSnapshot(
  context: OidcTransactionContext,
  input: CreateOidcIdentityInput,
): void {
  const provider = context.findOidcProfileSelectors(input.providerId)
  const changed =
    provider === null ||
    (input.expectedSubjectClaim !== undefined &&
      (provider.subjectClaim ?? null) !== input.expectedSubjectClaim) ||
    (input.expectedUsernameClaim !== undefined &&
      (provider.usernameClaim ?? null) !== input.expectedUsernameClaim) ||
    (input.expectedGitNameClaim !== undefined &&
      (provider.gitNameClaim ?? null) !== input.expectedGitNameClaim) ||
    (input.expectedEmailClaim !== undefined &&
      (provider.emailClaim ?? null) !== input.expectedEmailClaim)
  if (changed) {
    throw new ConflictError(
      'provider-config-changed',
      'provider identity/profile selectors changed while the sign-in was in flight',
    )
  }
}

function hasProfileSnapshot(input: CreateOidcIdentityInput): boolean {
  return (
    input.expectedSubjectClaim !== undefined ||
    input.expectedUsernameClaim !== undefined ||
    input.expectedGitNameClaim !== undefined ||
    input.expectedEmailClaim !== undefined
  )
}

function profileCommand(input: CreateOidcIdentityInput) {
  if (input.displayName === undefined || input.gitName === undefined) {
    throw new ConflictError(
      'oidc-profile-names-missing',
      'callback identity is missing resolved OIDC profile names',
    )
  }
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
  tx: DatabaseTransaction,
  input: CreateOidcIdentityInput,
): Promise<LoadedOidcState> {
  const loadedUsers = new Map<string, UserAccessRecord>()
  const byId = (await tx.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]
  if (byId !== undefined) loadedUsers.set(byId.id, mapUser(byId))
  if (input.email !== null) {
    const byEmail = (await tx.select().from(users).where(eq(users.email, input.email)).limit(1))[0]
    if (byEmail !== undefined) loadedUsers.set(byEmail.id, mapUser(byEmail))
  }
  const identity = (
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
          eq(userIdentities.providerId, input.providerId),
          eq(userIdentities.subject, input.subject),
        ),
      )
      .limit(1)
  )[0]
  const selectors = hasProfileSnapshot(input)
    ? (
        await tx
          .select({
            subjectClaim: oidcProviders.subjectClaim,
            usernameClaim: oidcProviders.usernameClaim,
            gitNameClaim: oidcProviders.gitNameClaim,
            emailClaim: oidcProviders.emailClaim,
          })
          .from(oidcProviders)
          .where(eq(oidcProviders.id, input.providerId))
          .limit(1)
      )[0]
    : undefined
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

function identityAccessDomainError(error: unknown): unknown {
  if (!(error instanceof UserAccessError)) return error
  if (error.kind === 'not-found') {
    return new NotFoundError(error.code, error.message, error.details)
  }
  return new ConflictError(error.code, error.message, error.details)
}

export function composeOidcIdentityOperations(
  input: OidcIdentityCompositionInput,
): OidcIdentityOperations {
  const { db, identityAccess } = input
  const session = databaseSessionFor(db)
  const engine = session.engine

  const mapWriteError = (error: unknown, identityInput: CreateOidcIdentityInput): unknown => {
    const target = engine.uniqueViolationTarget(error)
    if (target !== undefined && /user_identities[._]provider/i.test(target)) {
      return new ConflictError(
        'identity-already-linked',
        `provider/${identityInput.providerId} subject/${identityInput.subject} is already linked`,
      )
    }
    return identityAccessDomainError(mapUserAccessError(engine, error, 'sync-oidc-profile'))
  }

  const stageProfile = (
    context: OidcTransactionContext,
    identityInput: CreateOidcIdentityInput,
  ) => {
    if (!hasProfileSnapshot(identityInput)) return
    // RFC-220 S13：写入时先复核 provider 的 claim 选择器还是回调解析 claims 时那一套——它先于「profile
    // 名字是否齐全」，否则漂移会被报成 names-missing（旧 SQLite 版的顺序，两个 provider 现在同一份）。
    assertProviderSnapshot(context, identityInput)
    syncOidcProfileTransaction(context, profileCommand(identityInput), {
      now: identityInput.now ?? Date.now(),
      operationId: ulid(),
      auditId: ulid,
    })
  }

  const writeIdentity = async (
    identityInput: CreateOidcIdentityInput,
    beforeInsert?: (context: OidcTransactionContext) => void,
  ): Promise<OidcIdentityRecord> => {
    try {
      return await session.serializable(async (tx) => {
        const state = await loadState(tx, identityInput)
        const context = new OidcTransactionContext(
          state,
          identityInput.providerId,
          identityInput.subject,
          state.selectors,
        )
        const record = identityRecord(identityInput)
        beforeInsert?.(context)
        context.insertIdentity(record)
        stageProfile(context, identityInput)
        await persistUserAccessOperations(tx, context.operations)
        return record
      })
    } catch (error) {
      throw mapWriteError(error, identityInput)
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
      const row = (
        await db
          .select()
          .from(userIdentities)
          .where(
            and(eq(userIdentities.providerId, providerId), eq(userIdentities.subject, subject)),
          )
          .limit(1)
      )[0]
      return row ?? null
    },
    async createIdentity(identityInput) {
      return await writeIdentity(identityInput)
    },
    async createUserWithIdentity(userInput) {
      if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
      const now = userInput.now ?? Date.now()
      const userId = ulid()
      const identityInput = { ...userInput.identity, userId, now }
      try {
        return await session.serializable(async (tx) => {
          const policy = (
            await tx
              .select({ oidcDefaultRole: authLoginPolicy.oidcDefaultRole })
              .from(authLoginPolicy)
              .where(eq(authLoginPolicy.id, 'global'))
              .limit(1)
          )[0]
          if (policy === undefined) throw new Error('authentication policy singleton is missing')
          const state = await loadState(tx, identityInput)
          const usernameOwner = (
            await tx.select().from(users).where(eq(users.username, userInput.username)).limit(1)
          )[0]
          const usersForScope =
            usernameOwner === undefined || state.users.some((row) => row.id === usernameOwner.id)
              ? state.users
              : [...state.users, mapUser(usernameOwner)]
          const context = new OidcTransactionContext(
            { ...state, users: usersForScope },
            identityInput.providerId,
            identityInput.subject,
            state.selectors,
          )
          stageInitialUserAccess(context, {
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
            audit: { id: ulid(), actorUserId: null, actorKind: 'system', operationId: ulid() },
          })
          context.insertIdentity(identityRecord(identityInput))
          stageProfile(context, identityInput)
          await persistUserAccessOperations(tx, context.operations)
          return { userId }
        })
      } catch (error) {
        throw mapWriteError(error, identityInput)
      }
    },
    async bindInvitedUserWithIdentity(bindInput) {
      if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
      const now = bindInput.now ?? Date.now()
      await writeIdentity({ ...bindInput.identity, userId: bindInput.userId, now }, (context) =>
        context.activateUser(bindInput.userId, now),
      )
    },
    async syncPreferredSnapshot(profileInput) {
      if (identityAccess === undefined) throw new Error('identity-access-runtime-not-composed')
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
      const deleted = await session.transaction(async (tx) => {
        const row = (
          await tx
            .select({ id: userIdentities.id })
            .from(userIdentities)
            .where(eq(userIdentities.id, identityId))
            .limit(1)
        )[0]
        if (row === undefined) return false
        await tx.delete(userIdentities).where(eq(userIdentities.id, identityId))
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
