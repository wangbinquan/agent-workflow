import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import {
  PAT_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  type AuthLoginPolicy,
  type AuthMethodDiscovery,
  type OidcDefaultRole,
  type PatPublic,
  type PatPurpose,
  type Permission,
  type UpdateAuthLoginPolicyBody,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { DomainError, ForbiddenError } from '@/util/errors'
import { ALWAYS_WRITABLE_DATABASE_SOURCE } from './authPersistence'
import type {
  ActiveAuthPat,
  ActiveAuthSession,
  AuthCredentialRevocationReason,
  AuthPatRecord,
  AuthPersistence,
  AuthRuntimeOptions,
  AuthSessionRecord,
  AuthUserRecord,
  LocalPasswordWrite,
} from './authPersistence'

export const SESSION_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_LAST_USED_WRITE_INTERVAL_MS = 1_000

export interface SessionView {
  readonly id: string
  readonly userId: string
  readonly userAgent: string | null
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
}

export interface ResolvedSession {
  readonly session: SessionView
  readonly user: AuthUserRecord
}

export interface ResolvedPat {
  readonly user: AuthUserRecord
  readonly scopes: ReadonlyArray<Permission>
  readonly purpose: PatPurpose
  readonly patId: string
  readonly expiresAt: number | null
}

export interface CreateSessionOptions {
  readonly userId: string
  readonly userAgent?: string | null
  readonly ttlMs?: number
  readonly now?: number
}

export interface CreateSessionResult {
  readonly token: string
  readonly session: SessionView
}

export interface CreatePatOptions {
  readonly userId: string
  readonly name: string
  readonly scopes?: ReadonlyArray<Permission>
  readonly purpose: PatPurpose
  readonly expiresAt?: number | null
  readonly now?: number
}

export interface CreatePatResult {
  readonly token: string
  readonly meta: PatPublic
}

export interface PreparedBootstrapAdmin {
  readonly id?: string
  readonly username: string
  readonly email?: string
  readonly displayName: string
  readonly passwordHash: string
}

export interface CreatePasswordLoginSessionInput {
  readonly userId: string
  readonly verifiedPasswordHash: string
  readonly userAgent?: string | null
  readonly now?: number
  readonly ttlMs?: number
}

export interface AuthRuntime {
  readonly provider: DatabaseProvider
  readonly allowLegacyDaemonTestAccess: boolean
  getLoginPolicy(): Promise<AuthLoginPolicy>
  getLoginMethodDiscovery(oidcRuntimeAvailable: boolean): Promise<AuthMethodDiscovery>
  isBootstrapRequired(): Promise<boolean>
  assertBootstrapComplete(): Promise<AuthLoginPolicy>
  updateLoginPolicy(patch: UpdateAuthLoginPolicyBody, now?: number): Promise<AuthLoginPolicy>
  setPasswordLoginEnabled(enabled: boolean, now?: number): Promise<AuthLoginPolicy>
  setOidcDefaultRole(role: OidcDefaultRole, now?: number): Promise<AuthLoginPolicy>
  completeBootstrap(input: PreparedBootstrapAdmin, now?: number): Promise<AuthUserRecord>
  createPasswordLoginSession(input: CreatePasswordLoginSessionInput): Promise<{
    readonly token: string
    readonly user: AuthUserRecord
  }>
  findUserByUsername(username: string): Promise<AuthUserRecord | null>
  findUserById(userId: string): Promise<AuthUserRecord | null>
  findInvitedUserByEmail(email: string): Promise<AuthUserRecord | null>
  createSession(input: CreateSessionOptions): Promise<CreateSessionResult>
  createLoginSession(input: CreateSessionOptions): Promise<CreateSessionResult>
  lookupActiveSession(raw: string, now?: number): Promise<ResolvedSession | null>
  lookupActiveSessionByHash(
    hash: string,
    now?: number,
    opts?: { readonly touch?: boolean },
  ): Promise<ResolvedSession | null>
  findSessionOwner(sessionId: string): Promise<string | null>
  revokeSession(sessionId: string, now?: number): Promise<void>
  revokeAllSessionsForUser(userId: string, now?: number): Promise<void>
  sweepExpiredSessions(now?: number): Promise<number>
  listActiveSessionsForUser(userId: string, now?: number): Promise<ReadonlyArray<SessionView>>
  createPat(input: CreatePatOptions): Promise<CreatePatResult>
  lookupActivePat(raw: string, now?: number): Promise<ResolvedPat | null>
  lookupActivePatByHash(
    hash: string,
    now?: number,
    opts?: { readonly touch?: boolean },
  ): Promise<ResolvedPat | null>
  findPatOwner(patId: string): Promise<string | null>
  revokePat(patId: string, now?: number): Promise<void>
  listAllPats(): Promise<ReadonlyArray<PatPublic & { readonly userId: string }>>
  listPatsForUser(userId: string): Promise<ReadonlyArray<PatPublic>>
  isOidcManagedUser(userId: string): Promise<boolean>
  listOidcManagedUserIds(userIds?: ReadonlyArray<string>): Promise<ReadonlySet<string>>
  writeLocalPasswordIfUnmanaged(input: LocalPasswordWrite): Promise<void>
}

function missingPolicy(): never {
  throw new DomainError(
    'auth-login-policy-missing',
    'authentication policy singleton is missing',
    500,
  )
}

function generateSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

function generatePatToken(): string {
  return `${PAT_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

export function hashAuthToken(raw: string): string {
  return sha256Hex(raw)
}

function prepareSession(input: CreateSessionOptions): {
  readonly token: string
  readonly record: AuthSessionRecord
} {
  const now = input.now ?? Date.now()
  const token = generateSessionToken()
  return {
    token,
    record: {
      id: ulid(),
      userId: input.userId,
      tokenHash: hashAuthToken(token),
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + (input.ttlMs ?? SESSION_DEFAULT_TTL_MS),
      revokedAt: null,
    },
  }
}

function sessionView(record: AuthSessionRecord): SessionView {
  const { tokenHash: _tokenHash, ...view } = record
  return view
}

function safeParseScopes(raw: string): Permission[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is Permission => typeof value === 'string')
  } catch {
    return []
  }
}

function patView(record: AuthPatRecord): PatPublic {
  return {
    id: record.id,
    name: record.name,
    scopes: safeParseScopes(record.scopesJson),
    purpose: record.purpose,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  }
}

function resolvedSession(input: ActiveAuthSession, now: number, touch: boolean): ResolvedSession {
  return {
    user: input.user,
    session: {
      ...sessionView(input.session),
      lastUsedAt: touch ? now : input.session.lastUsedAt,
      revokedAt: null,
    },
  }
}

function resolvedPat(input: ActiveAuthPat): ResolvedPat {
  return {
    user: input.user,
    scopes: safeParseScopes(input.pat.scopesJson),
    purpose: input.pat.purpose,
    patId: input.pat.id,
    expiresAt: input.pat.expiresAt,
  }
}

export function createAuthRuntime(input: {
  readonly provider: DatabaseProvider
  readonly persistence: AuthPersistence
  readonly options?: AuthRuntimeOptions
}): AuthRuntime {
  const { persistence } = input
  // RFC-349 T10: the last-used projections are the only writes the request path
  // still makes while a migration has frozen the source (the route gate cannot
  // see them — they happen in authentication, on the deliberately exempt
  // migration-control path). Drop them for the duration instead of failing the
  // copy; see `DatabaseSourceWriteWindow`.
  const sourceWritable = (): boolean =>
    input.options?.sourceWriteWindow?.writable() ?? ALWAYS_WRITABLE_DATABASE_SOURCE.writable()
  const notify = (reason: AuthCredentialRevocationReason): void => {
    input.options?.onCredentialRevoked?.(reason)
  }
  const lookupActiveSessionByHash: AuthRuntime['lookupActiveSessionByHash'] = async (
    hash,
    now = Date.now(),
    opts = {},
  ) => {
    const touch = (opts.touch ?? true) && sourceWritable()
    const active = await persistence.resolveSessionByHash({
      hash,
      now,
      touch,
      touchIntervalMs: SESSION_LAST_USED_WRITE_INTERVAL_MS,
    })
    return active === null ? null : resolvedSession(active, now, touch)
  }
  const lookupActivePatByHash: AuthRuntime['lookupActivePatByHash'] = async (
    hash,
    now = Date.now(),
    opts = {},
  ) => {
    const active = await persistence.resolvePatByHash({
      hash,
      now,
      touch: (opts.touch ?? true) && sourceWritable(),
    })
    return active === null ? null : resolvedPat(active)
  }
  const runtime: AuthRuntime = {
    provider: input.provider,
    allowLegacyDaemonTestAccess: input.options?.allowLegacyDaemonTestAccess ?? false,
    async getLoginPolicy() {
      return (await persistence.getLoginPolicy()) ?? missingPolicy()
    },
    async getLoginMethodDiscovery(oidcRuntimeAvailable) {
      return (await persistence.getLoginMethodDiscovery(oidcRuntimeAvailable)) ?? missingPolicy()
    },
    async isBootstrapRequired() {
      return ((await persistence.getLoginPolicy()) ?? missingPolicy()).bootstrapCompletedAt === null
    },
    async assertBootstrapComplete() {
      const policy = (await persistence.getLoginPolicy()) ?? missingPolicy()
      if (policy.bootstrapCompletedAt === null) {
        throw new ForbiddenError(
          'bootstrap-admin-required',
          'create the first administrator before using this login method',
          { setupPath: '/setup/admin' },
        )
      }
      return policy
    },
    async updateLoginPolicy(patch, now = Date.now()) {
      return await persistence.updateLoginPolicy({ ...patch, now })
    },
    async setPasswordLoginEnabled(enabled, now = Date.now()) {
      return await persistence.updateLoginPolicy({ passwordLoginEnabled: enabled, now })
    },
    async setOidcDefaultRole(role, now = Date.now()) {
      return await persistence.updateLoginPolicy({ oidcDefaultRole: role, now })
    },
    async completeBootstrap(admin, now = Date.now()) {
      const created = await persistence.completeBootstrap({
        id: admin.id ?? ulid(),
        username: admin.username,
        email: admin.email?.toLowerCase() ?? null,
        displayName: admin.displayName,
        passwordHash: admin.passwordHash,
        now,
        auditId: ulid(),
        operationId: ulid(),
      })
      notify('bootstrap-completed')
      return created
    },
    async createPasswordLoginSession(options) {
      const { token, record } = prepareSession(options)
      const user = await persistence.createPasswordLoginSession({
        userId: options.userId,
        verifiedPasswordHash: options.verifiedPasswordHash,
        session: record,
      })
      return { token, user }
    },
    findUserByUsername: (username) => persistence.findUserByUsername(username),
    findUserById: (userId) => persistence.findUserById(userId),
    findInvitedUserByEmail: (email) => persistence.findInvitedUserByEmail(email.toLowerCase()),
    async createSession(options) {
      const { token, record } = prepareSession(options)
      await persistence.insertSession(record)
      return { token, session: sessionView(record) }
    },
    async createLoginSession(options) {
      const { token, record } = prepareSession(options)
      await persistence.insertLoginSession(record)
      return { token, session: sessionView(record) }
    },
    async lookupActiveSession(raw, now = Date.now()) {
      if (!raw.startsWith(SESSION_TOKEN_PREFIX)) return null
      return await lookupActiveSessionByHash(hashAuthToken(raw), now)
    },
    lookupActiveSessionByHash,
    findSessionOwner: (sessionId) => persistence.findSessionOwner(sessionId),
    async revokeSession(sessionId, now = Date.now()) {
      await persistence.revokeSession(sessionId, now)
      notify('session-revoked')
    },
    async revokeAllSessionsForUser(userId, now = Date.now()) {
      await persistence.revokeSessionsForUser(userId, now)
      notify('sessions-revoked-bulk')
    },
    sweepExpiredSessions: (now = Date.now()) => persistence.sweepExpiredSessions(now),
    async listActiveSessionsForUser(userId, now = Date.now()) {
      return (await persistence.listActiveSessionsForUser(userId, now)).map(sessionView)
    },
    async createPat(options) {
      const now = options.now ?? Date.now()
      const token = generatePatToken()
      const record: AuthPatRecord = {
        id: ulid(),
        userId: options.userId,
        name: options.name,
        tokenHash: hashAuthToken(token),
        scopesJson: JSON.stringify(options.scopes ? [...options.scopes] : []),
        purpose: options.purpose,
        createdAt: now,
        lastUsedAt: null,
        expiresAt: options.expiresAt ?? null,
        revokedAt: null,
      }
      await persistence.insertPat(record)
      return { token, meta: patView(record) }
    },
    async lookupActivePat(raw, now = Date.now()) {
      if (!raw.startsWith(PAT_TOKEN_PREFIX)) return null
      return await lookupActivePatByHash(hashAuthToken(raw), now)
    },
    lookupActivePatByHash,
    findPatOwner: (patId) => persistence.findPatOwner(patId),
    async revokePat(patId, now = Date.now()) {
      await persistence.revokePat(patId, now)
      notify('pat-revoked')
    },
    async listAllPats() {
      return (await persistence.listAllPats()).map((record) => ({
        ...patView(record),
        userId: record.userId,
      }))
    },
    async listPatsForUser(userId) {
      return (await persistence.listPatsForUser(userId)).map(patView)
    },
    isOidcManagedUser: (userId) => persistence.isOidcManagedUser(userId),
    listOidcManagedUserIds: (userIds) => persistence.listOidcManagedUserIds(userIds),
    writeLocalPasswordIfUnmanaged: (write) => persistence.writeLocalPasswordIfUnmanaged(write),
  }
  return Object.freeze(runtime)
}
