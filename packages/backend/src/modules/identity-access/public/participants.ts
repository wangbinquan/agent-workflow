import type { ResolvedAuthoritySubject } from './types'

export type DirectTransport = 'http' | 'mcp' | 'cli'
export type PrincipalSource = 'session' | 'pat' | 'daemon' | 'cli' | 'system'
export type DelegatedSource =
  | 'schedule'
  | 'webhook'
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
