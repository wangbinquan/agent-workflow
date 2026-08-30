import type { PatPurpose, Permission, Role } from '@agent-workflow/shared'
import type { ManagedUserStatus, ResolvedAuthoritySubject } from './types'

export type DirectTransport = 'http' | 'mcp' | 'cli'
export type PrincipalSource = 'session' | 'pat' | 'daemon' | 'cli' | 'system'

declare const requestAuthorityBrand: unique symbol
declare const directRequestAuthorityBrand: unique symbol
declare const admittedSessionCredentialBrand: unique symbol
declare const admittedPatCredentialBrand: unique symbol
declare const admittedDaemonCredentialBrand: unique symbol
declare const idempotencyKeyBrand: unique symbol
declare const delegatedAuthorityBrand: unique symbol
declare const directAuthenticatedAuthorityBrand: unique symbol
declare const legacyActorProjectionBrand: unique symbol
declare const presenceLeaseBrand: unique symbol

/** Opaque current-request authority. The subject claim lives only in the
 * identity-access runtime registry and cannot be spread, forged or serialized. */
export interface RequestAuthority {
  readonly [requestAuthorityBrand]: 'current-request-authority'
}

/** Opaque authority minted exactly once after a credential adapter admits a
 * session, PAT or daemon credential.  Account facts stay in the owning runtime
 * registry; transports pass this handle by identity. */
export interface DirectRequestAuthority extends RequestAuthority {
  readonly [directRequestAuthorityBrand]: 'direct-request-authority-v1'
}

/** Credential adapters freeze one of these branded facts only after the
 * corresponding token/session check succeeds.  The authority factory never
 * accepts a plain `{ userId, source }` mint request. */
export interface AdmittedSessionCredential {
  readonly [admittedSessionCredentialBrand]: 'admitted-session-credential-v1'
  readonly userId: string
}

export interface AdmittedPatCredential {
  readonly [admittedPatCredentialBrand]: 'admitted-pat-credential-v1'
  readonly userId: string
  readonly scopes: ReadonlyArray<Permission>
  readonly purpose: PatPurpose
  readonly patId: string
}

export interface AdmittedDaemonCredential {
  readonly [admittedDaemonCredentialBrand]: 'admitted-daemon-credential-v1'
}

export interface CommandContext {
  readonly authority: RequestAuthority
  readonly operationId: string
  readonly correlationId: string
  readonly causationId?: string
  readonly now: number
}

export interface QueryContext {
  readonly authority: RequestAuthority
  readonly operationId: string
  readonly correlationId: string
}

export type ValidatedIdempotencyKey = string & {
  readonly [idempotencyKeyBrand]: 'validated-idempotency-key'
}

export interface IdempotentCommandContext extends CommandContext {
  readonly idempotencyKey: ValidatedIdempotencyKey
}

export interface InitialUserAccessProvision {
  readonly user: {
    readonly id: string
    readonly username: string
    readonly email: string | null
    readonly displayName: string
    readonly gitName: string
    readonly passwordHash: string | null
    readonly role: Role
    readonly status: ManagedUserStatus
    readonly forcePasswordChange: boolean
    readonly createdBy: string | null
    readonly createdAt: number
  }
  readonly audit: {
    readonly id: string
    readonly actorUserId: string | null
    readonly actorKind: 'session' | 'cli' | 'system'
    readonly operationId: string
  }
}

/** Transaction-bound participant for bootstrap/OIDC account creation. The
 * composition root binds it to one live persistence scope; public consumers
 * can insert through that bound lifetime without importing platform types. */
export interface InitialUserAccessProvisioner {
  insert(provision: InitialUserAccessProvision): void
}

export interface AuthenticatedPrincipal {
  readonly userId: string
  readonly source: PrincipalSource
}

/**
 * Current-request authority frozen by the authenticated transport. Unlike a
 * plain Actor this value can only be minted by the identity-access factory, so
 * operation descriptors cannot accept a forgeable role/permission bag.
 */
export interface AuthenticatedAuthoritySnapshot {
  readonly user: Readonly<{
    readonly id: string
    readonly username: string
    readonly displayName: string
    readonly role: Role
    readonly status: 'active' | 'disabled' | 'invited'
  }>
  readonly source: Extract<PrincipalSource, 'session' | 'pat' | 'daemon'>
  readonly permissions: ReadonlySet<Permission>
  readonly purpose?: PatPurpose
  readonly patId?: string
  readonly authorityRevision?: number
}

/** The sole compatibility projection for bounded contexts that still consume
 * the legacy Actor shape.  It is produced from a registered authority claim,
 * never from caller-supplied account facts. */
export interface LegacyActorProjection extends AuthenticatedAuthoritySnapshot {
  readonly [legacyActorProjectionBrand]: 'legacy-actor-projection-v1'
  readonly userId: string
}

/** Narrow compatibility participant for legacy consumers that already hold a
 * subject resolved by identity-access. The branded projection remains owned by
 * the runtime; consumers never import its implementation. */
export interface LegacyActorProjectionFactory {
  fromResolvedSubject(subject: ResolvedAuthoritySubject): LegacyActorProjection
}

export interface DirectAuthenticatedAuthority extends LegacyActorProjection {
  readonly [directAuthenticatedAuthorityBrand]: 'direct-authenticated-authority'
}

export interface DelegatedRequestAuthority extends RequestAuthority {
  readonly [delegatedAuthorityBrand]: 'delegated-request-authority-v1'
}

export interface DirectAuthorityIdentity {
  readonly authority: DirectRequestAuthority
  readonly actor: DirectAuthenticatedAuthority
}

/** Credential adapters may supply only the admitted credential facts.  The
 * runtime re-resolves current account state and mints the handle/projection as
 * one indivisible result. */
export interface DirectAuthorityAdmission {
  fromSession(credential: AdmittedSessionCredential): Promise<DirectAuthorityIdentity | null>
  fromPat(credential: AdmittedPatCredential): Promise<DirectAuthorityIdentity | null>
  fromDaemon(credential: AdmittedDaemonCredential): Promise<DirectAuthorityIdentity | null>
}

export interface DirectCommandContextFactory {
  fromAuthority(
    authority: DirectRequestAuthority,
    transport: DirectTransport,
    at?: number,
  ): CommandContext
  fromAuthorityWithIdempotency(
    authority: DirectRequestAuthority,
    transport: DirectTransport,
    key: ValidatedIdempotencyKey,
  ): IdempotentCommandContext
  resolveCommandContext(context: CommandContext): AuthenticatedPrincipal
}

export interface DirectQueryContextFactory {
  queryFromAuthority(authority: DirectRequestAuthority, transport: DirectTransport): QueryContext
  resolveQueryContext(context: QueryContext): AuthenticatedPrincipal
}

export interface DirectAuthorityBinding {
  authorityForLegacyProjection(projection: AuthenticatedAuthoritySnapshot): DirectRequestAuthority
  legacyProjectionForAuthority(authority: DirectRequestAuthority): DirectAuthenticatedAuthority
}

/** Credential/inherited adapters receive current account facts, never a token secret or Actor. */
export interface CurrentSubjectAccessResolver {
  resolveCurrentSubject(userId: string): Promise<ResolvedAuthoritySubject | null>
}

export type DelegatedAuthorityAdmission = Readonly<{
  authority: DelegatedRequestAuthority
  actor: LegacyActorProjection
  context: CommandContext | IdempotentCommandContext
}>

export interface DelegatedRequestAuthorityFactory {
  forSchedule(input: {
    readonly ownerUserId: string
    readonly scheduleId: string
    readonly invocation:
      | { readonly kind: 'automatic'; readonly occurrenceAt: number }
      | { readonly kind: 'manual' }
  }): Promise<DelegatedAuthorityAdmission | null>
  forWebhook(input: {
    readonly ownerUserId: string
    readonly triggerId: string
    readonly deliveryId: string
    readonly fireId: string
  }): Promise<DelegatedAuthorityAdmission | null>
  forCall(input: {
    readonly kind: 'call-workflow' | 'call-workgroup'
    readonly ownerUserId: string
    readonly parentTaskId: string
    readonly parentNodeRunId: string
  }): Promise<DelegatedAuthorityAdmission | null>
}

export interface PresenceLease {
  readonly [presenceLeaseBrand]: 'presence-lease-v1'
  release(): void
}

export interface PresenceConnectionTracker {
  /** Returns null for PAT/daemon authorities; only a session contributes online state. */
  open(authority: DirectRequestAuthority): PresenceLease | null
}

export interface PresenceQuery {
  snapshot(): ReadonlyArray<string>
}

// RFC-317 T41（findings TP-03）—— 出站授权围栏的**同步**读契约。传输层（ws/）经这条
// 端口取「账号是否仍有效 + 当前授权版本」，不再自己拼 `users` 表的 SQL。
//
// 放在 participants 而不是 queries：本模块的约定是「可执行查询用例进 queries.ts
// （GetUserAccess / requireUserAccess），**接口型端口**进 participants.ts
// （CurrentSubjectAccessResolver / PresenceQuery …）」。RFC-294 的跨界判据
// 也只允许 participants/events/types 走 type-only 边——一条被 type-only 引用的接口，
// 放 queries.ts 会直接判违规。
export type {
  AuthorityFenceRecord,
  UserAccessFenceReader,
} from '../application/ports/userAccessRepository'
