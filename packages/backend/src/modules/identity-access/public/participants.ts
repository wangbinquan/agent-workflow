import type { ResolvedAuthoritySubject } from './types'

export type DirectTransport = 'http' | 'mcp' | 'cli'
export type PrincipalSource = 'session' | 'pat' | 'daemon' | 'cli' | 'system'
export type DelegatedSource =
  | 'schedule'
  | 'webhook'
  | 'event'
  | 'call-workflow'
  | 'call-workgroup'
  | 'code-host'

declare const subjectRefBrand: unique symbol
declare const requestAuthorityBrand: unique symbol
declare const idempotencyKeyBrand: unique symbol
declare const delegatedAuthorityBrand: unique symbol

export interface AuthorizationSubjectRef {
  readonly [subjectRefBrand]: 'authorization-subject-ref'
  readonly userId: string
}

/** Opaque current-request authority. The subject claim lives only in the
 * identity-access runtime registry and cannot be spread, forged or serialized. */
export interface RequestAuthority {
  readonly [requestAuthorityBrand]: 'current-request-authority'
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

export interface AuthenticatedPrincipal {
  readonly userId: string
  readonly source: PrincipalSource
}

/** Trusted, non-serializable projection of a direct CommandContext. Commands
 * may use this to re-read current authority in their own transaction without
 * accepting an Actor or permission snapshot in the command payload. */
export interface ResolvedDirectRequestAuthority {
  readonly userId: string
  readonly source: PrincipalSource
}

export interface DurableSourceAttemptRef {
  readonly sourceId: string
  readonly attemptId: string
}

export interface DelegatedAuthorityRef {
  readonly [delegatedAuthorityBrand]: 'delegated-authority-ref'
  readonly subjectRef: AuthorizationSubjectRef
  readonly revision: number
}

export interface DirectOperationContextFactory {
  fromAuthenticatedPrincipal(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
    at?: number,
  ): CommandContext
  fromAuthenticatedPrincipalWithIdempotency(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
    key: ValidatedIdempotencyKey,
  ): IdempotentCommandContext
  queryFromAuthenticatedPrincipal(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
  ): QueryContext
  resolveCommandContext(context: CommandContext): ResolvedDirectRequestAuthority
}

/** Credential/inherited adapters receive current account facts, never a token secret or Actor. */
export interface CurrentSubjectAccessResolver {
  resolveCurrentSubject(userId: string): Promise<ResolvedAuthoritySubject | null>
}

export interface DelegatedAuthorityResolver {
  resolve(source: DelegatedSource, subject: AuthorizationSubjectRef): Promise<DelegatedAuthorityRef>
}

export interface DelegatedOperationContextFactory {
  fromDurableAttempt(
    authority: DelegatedAuthorityRef,
    source: DelegatedSource,
    attempt: DurableSourceAttemptRef,
  ): IdempotentCommandContext
}

// RFC-317 T41（findings TP-03）—— 出站授权围栏的**同步**读契约。传输层（ws/）经这条
// 端口取「账号是否仍有效 + 当前授权版本」，不再自己拼 `users` 表的 SQL。
//
// 放在 participants 而不是 queries：本模块的约定是「可执行查询用例进 queries.ts
// （GetUserAccess / requireUserAccess），**接口型端口**进 participants.ts
// （DelegatedAuthorityResolver / CurrentSubjectAccessResolver …）」。RFC-294 的跨界判据
// 也只允许 participants/events/types 走 type-only 边——一条被 type-only 引用的接口，
// 放 queries.ts 会直接判违规。
export type {
  AuthorityFenceRecord,
  UserAccessFenceReader,
} from '../application/ports/userAccessRepository'
