// RFC-344 — transport-neutral operation and binding contracts.
//
// This module is intentionally data-only. Business modules may export typed
// operation descriptors, while bootstrap/adapters collect and project them;
// no business code receives a catalog or a string-based service locator.

import type { Permission } from '@agent-workflow/shared'
import type { PublicErrorCode } from '@/platform/errors/publicError'

declare const OPERATION_ID: unique symbol

/** Stable application contract id: `<bounded-context>.<verb-subject>.v<major>`. */
export type OperationId = string & { readonly [OPERATION_ID]: true }

export type OperationKind =
  | 'command'
  | 'idempotent-command'
  | 'query'
  | 'credential-authentication'
  | 'verified-ingress'
  | 'bootstrap-admin'
  | 'public-liveness'

export type OperationContextKind =
  | 'authenticated-command'
  | 'authenticated-query'
  | 'credential'
  | 'verified-ingress'
  | 'bootstrap'
  | 'public'

/**
 * A versioned codec at an application boundary. Implementations must reject
 * unknown keys; the descriptor owns the codec and every transport reuses it.
 */
export interface VersionedExactCodec<T> {
  readonly version: number
  readonly name: string
  parse(value: unknown): T
}

interface OperationDescriptorBase<I, O> {
  readonly id: OperationId
  readonly summary: string
  readonly input: VersionedExactCodec<I>
  readonly output: VersionedExactCodec<O>
  readonly publicErrors: ReadonlyArray<PublicErrorCode>
  readonly permissions: ReadonlyArray<Permission>
  readonly publicReason?: string
}

export interface CommandOperationDescriptor<I, O, C = unknown> extends OperationDescriptorBase<
  I,
  O
> {
  readonly kind: 'command'
  readonly contextKind: 'authenticated-command'
  invoke(context: C, input: I): Promise<O> | O
}

export interface IdempotentCommandOperationDescriptor<
  I,
  O,
  C = unknown,
> extends OperationDescriptorBase<I, O> {
  readonly kind: 'idempotent-command'
  readonly contextKind: 'authenticated-command'
  readonly idempotencyKey: {
    readonly field: keyof I & string
    readonly minLength: number
    readonly maxLength: number
    readonly pattern: RegExp
  }
  invoke(context: C, input: I): Promise<O> | O
}

export interface QueryOperationDescriptor<I, O, C = unknown> extends OperationDescriptorBase<I, O> {
  readonly kind: 'query'
  readonly contextKind: 'authenticated-query'
  invoke(context: C, input: I): Promise<O> | O
}

export interface CredentialAuthenticationOperationDescriptor<
  I,
  O,
  C = unknown,
> extends OperationDescriptorBase<I, O> {
  readonly kind: 'credential-authentication'
  readonly contextKind: 'credential'
  invoke(context: C, input: I): Promise<O> | O
}

export interface VerifiedIngressOperationDescriptor<
  S extends string,
  I,
  O,
  C = unknown,
> extends OperationDescriptorBase<I, O> {
  readonly kind: 'verified-ingress'
  readonly contextKind: 'verified-ingress'
  readonly ingressSource: S
  invoke(context: C, input: I): Promise<O> | O
}

export interface BootstrapAdminOperationDescriptor<
  I,
  O,
  C = unknown,
> extends OperationDescriptorBase<I, O> {
  readonly kind: 'bootstrap-admin'
  readonly contextKind: 'bootstrap'
  invoke(context: C, input: I): Promise<O> | O
}

export interface PublicLivenessOperationDescriptor<O, C = unknown> extends OperationDescriptorBase<
  Record<never, never>,
  O
> {
  readonly kind: 'public-liveness'
  readonly contextKind: 'public'
  invoke(context: C, input: Record<never, never>): Promise<O> | O
}

export type OperationDescriptor<I = unknown, O = unknown, C = unknown> =
  | CommandOperationDescriptor<I, O, C>
  | IdempotentCommandOperationDescriptor<I, O, C>
  | QueryOperationDescriptor<I, O, C>
  | CredentialAuthenticationOperationDescriptor<I, O, C>
  | VerifiedIngressOperationDescriptor<string, I, O, C>
  | BootstrapAdminOperationDescriptor<I, O, C>
  | PublicLivenessOperationDescriptor<O, C>

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type TokenAccess = 'allow' | 'never'

export interface HttpOperationBinding {
  readonly kind: 'http'
  readonly operationId: OperationId
  readonly method: HttpMethod
  readonly path: string
  readonly tokenAccess: TokenAccess
}

export interface HttpOperationInput {
  readonly params?: Readonly<Record<string, string | number>>
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
}

export interface OperationResult {
  readonly status: number
  readonly body: unknown
  readonly auditSnapshot?: unknown
}

export type OperationInvoker = (
  operationId: OperationId,
  input?: HttpOperationInput,
) => Promise<OperationResult>

export interface DirectMcpBinding {
  readonly kind: 'mcp-direct'
  readonly toolName: string
  readonly operationId: OperationId
}

export interface ParameterizedMcpCase {
  readonly selector: string
  readonly operationId: OperationId
}

export interface ParameterizedMcpBinding {
  readonly kind: 'mcp-parameterized'
  readonly toolName: string
  readonly cases: ReadonlyArray<ParameterizedMcpCase>
}

export interface CompositeMcpBinding {
  readonly kind: 'mcp-composite'
  readonly toolName: string
  readonly dependencies: ReadonlyArray<OperationId>
}

export interface LocalMcpBinding {
  readonly kind: 'mcp-local'
  readonly toolName: string
  readonly operationId: OperationId
}

export type McpOperationBinding =
  | DirectMcpBinding
  | ParameterizedMcpBinding
  | CompositeMcpBinding
  | LocalMcpBinding
