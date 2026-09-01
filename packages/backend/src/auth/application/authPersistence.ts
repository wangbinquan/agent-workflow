import type {
  AuthLoginPolicy,
  AuthMethodDiscovery,
  OidcDefaultRole,
  PatPurpose,
  Role,
} from '@agent-workflow/shared'

export type AuthAccountStatus = 'active' | 'disabled' | 'invited'

export interface AuthUserRecord {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly displayName: string
  readonly gitName: string
  readonly passwordHash: string | null
  readonly role: Role
  readonly status: AuthAccountStatus
  readonly forcePasswordChange: boolean
  readonly createdBy: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastLoginAt: number | null
  readonly schemaVersion: number
  readonly accessRevision: number
}

export interface AuthSessionRecord {
  readonly id: string
  readonly userId: string
  readonly tokenHash: string
  readonly userAgent: string | null
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
}

export interface AuthPatRecord {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly tokenHash: string
  readonly scopesJson: string
  readonly purpose: PatPurpose
  readonly createdAt: number
  readonly lastUsedAt: number | null
  readonly expiresAt: number | null
  readonly revokedAt: number | null
}

export interface ActiveAuthSession {
  readonly session: AuthSessionRecord
  readonly user: AuthUserRecord
}

export interface ActiveAuthPat {
  readonly pat: AuthPatRecord
  readonly user: AuthUserRecord
}

export interface BootstrapAdminRecord {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly displayName: string
  readonly passwordHash: string
  readonly now: number
  readonly auditId: string
  readonly operationId: string
}

export interface PasswordLoginSessionRecord {
  readonly userId: string
  readonly verifiedPasswordHash: string
  readonly session: AuthSessionRecord
}

export interface LocalPasswordWrite {
  readonly userId: string
  readonly passwordHash: string
  readonly forcePasswordChange: boolean
  readonly activate: boolean
  readonly updatedAt: number
}

/**
 * Provider-neutral persistence contract for authentication. Every method that
 * spans multiple rows is one provider transaction; application callers never
 * receive a database handle or provider-specific query builder.
 */
export interface AuthPersistence {
  getLoginPolicy(): Promise<AuthLoginPolicy | null>
  getLoginMethodDiscovery(oidcRuntimeAvailable: boolean): Promise<AuthMethodDiscovery | null>
  updateLoginPolicy(input: {
    readonly passwordLoginEnabled?: boolean
    readonly oidcDefaultRole?: OidcDefaultRole
    readonly now: number
  }): Promise<AuthLoginPolicy>
  completeBootstrap(input: BootstrapAdminRecord): Promise<AuthUserRecord>
  createPasswordLoginSession(input: PasswordLoginSessionRecord): Promise<AuthUserRecord>

  findUserByUsername(username: string): Promise<AuthUserRecord | null>
  findUserById(userId: string): Promise<AuthUserRecord | null>
  findInvitedUserByEmail(email: string): Promise<AuthUserRecord | null>

  insertSession(session: AuthSessionRecord): Promise<void>
  insertLoginSession(session: AuthSessionRecord): Promise<void>
  resolveSessionByHash(input: {
    readonly hash: string
    readonly now: number
    readonly touch: boolean
    readonly touchIntervalMs: number
  }): Promise<ActiveAuthSession | null>
  findSessionOwner(sessionId: string): Promise<string | null>
  revokeSession(sessionId: string, now: number): Promise<void>
  revokeSessionsForUser(userId: string, now: number): Promise<void>
  sweepExpiredSessions(now: number): Promise<number>
  listActiveSessionsForUser(userId: string, now: number): Promise<ReadonlyArray<AuthSessionRecord>>

  insertPat(pat: AuthPatRecord): Promise<void>
  resolvePatByHash(input: {
    readonly hash: string
    readonly now: number
    readonly touch: boolean
  }): Promise<ActiveAuthPat | null>
  findPatOwner(patId: string): Promise<string | null>
  revokePat(patId: string, now: number): Promise<void>
  listAllPats(): Promise<ReadonlyArray<AuthPatRecord>>
  listPatsForUser(userId: string): Promise<ReadonlyArray<AuthPatRecord>>

  isOidcManagedUser(userId: string): Promise<boolean>
  listOidcManagedUserIds(userIds?: ReadonlyArray<string>): Promise<ReadonlySet<string>>
  writeLocalPasswordIfUnmanaged(input: LocalPasswordWrite): Promise<void>
}

export type AuthCredentialRevocationReason =
  | 'session-revoked'
  | 'sessions-revoked-bulk'
  | 'pat-revoked'
  | 'bootstrap-completed'

export interface AuthRuntimeOptions {
  readonly allowLegacyDaemonTestAccess?: boolean
  readonly onCredentialRevoked?: (reason: AuthCredentialRevocationReason) => void
}

export type AuthProvider = 'sqlite' | 'postgresql'

export interface AuthPersistenceBinding {
  readonly provider: AuthProvider
  readonly persistence: AuthPersistence
}
