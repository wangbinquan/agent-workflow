import type {
  AuthenticatedPrincipal,
  AuthorizationSubjectRef,
  CommandContext,
  DelegatedAuthorityRef,
  DelegatedOperationContextFactory as DelegatedOperationContextFactoryPort,
  DelegatedSource,
  DirectOperationContextFactory as DirectOperationContextFactoryPort,
  DirectTransport,
  DurableSourceAttemptRef,
  IdempotentCommandContext,
  PrincipalSource,
  QueryContext,
  RequestAuthority,
  ResolvedDirectRequestAuthority,
  ValidatedIdempotencyKey,
} from '../public/participants'

export type {
  AuthenticatedPrincipal,
  AuthorizationSubjectRef,
  CommandContext,
  DelegatedAuthorityRef,
  DelegatedSource,
  DirectTransport,
  DurableSourceAttemptRef,
  IdempotentCommandContext,
  PrincipalSource,
  QueryContext,
  RequestAuthority,
  ValidatedIdempotencyKey,
} from '../public/participants'

interface TrustedContextMetadata {
  readonly source: PrincipalSource | DelegatedSource
  readonly transport: DirectTransport | 'delegated'
}

const authorityClaims = new WeakMap<RequestAuthority, AuthorizationSubjectRef>()
const contextMetadata = new WeakMap<object, TrustedContextMetadata>()
const delegatedAuthorityClaims = new WeakMap<
  DelegatedAuthorityRef,
  Readonly<{
    userId: string
    revision: number
    source: DelegatedSource
  }>
>()

function subjectRef(userId: string): AuthorizationSubjectRef {
  return Object.freeze({ userId }) as AuthorizationSubjectRef
}

function mintRequestAuthority(userId: string): RequestAuthority {
  const handle = Object.freeze({}) as RequestAuthority
  authorityClaims.set(handle, subjectRef(userId))
  return handle
}

export function subjectRefOf(authority: RequestAuthority): AuthorizationSubjectRef {
  const claim = authorityClaims.get(authority)
  if (claim === undefined) throw new Error('untrusted-request-authority')
  return claim
}

export interface OperationContextFactoryDeps {
  readonly id: () => string
  readonly now: () => number
}

export class DirectOperationContextFactory implements DirectOperationContextFactoryPort {
  constructor(private readonly deps: OperationContextFactoryDeps) {}

  fromAuthenticatedPrincipal(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
    at?: number,
  ): CommandContext {
    const operationId = this.deps.id()
    const context: CommandContext = Object.freeze({
      authority: mintRequestAuthority(principal.userId),
      operationId,
      correlationId: operationId,
      now: at ?? this.deps.now(),
    })
    contextMetadata.set(context, { source: principal.source, transport })
    return context
  }

  fromAuthenticatedPrincipalWithIdempotency(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
    key: ValidatedIdempotencyKey,
  ): IdempotentCommandContext {
    const direct = this.fromAuthenticatedPrincipal(principal, transport)
    const context: IdempotentCommandContext = Object.freeze({ ...direct, idempotencyKey: key })
    contextMetadata.set(context, { source: principal.source, transport })
    return context
  }

  queryFromAuthenticatedPrincipal(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
  ): QueryContext {
    const operationId = this.deps.id()
    const context: QueryContext = Object.freeze({
      authority: mintRequestAuthority(principal.userId),
      operationId,
      correlationId: operationId,
    })
    contextMetadata.set(context, { source: principal.source, transport })
    return context
  }

  resolveCommandContext(context: CommandContext): ResolvedDirectRequestAuthority {
    const metadata = trustedContextMetadata(context)
    if (metadata.transport === 'delegated') throw new Error('direct-command-context-required')
    return Object.freeze({
      userId: subjectRefOf(context.authority).userId,
      source: metadata.source as PrincipalSource,
    })
  }
}

export function trustedContextMetadata(
  context: CommandContext | QueryContext,
): TrustedContextMetadata {
  const value = contextMetadata.get(context)
  if (value === undefined) throw new Error('untrusted-operation-context')
  return value
}

export function createDelegatedAuthorityRef(
  userId: string,
  revision: number,
  source: DelegatedSource,
): DelegatedAuthorityRef {
  const authority = Object.freeze({
    subjectRef: subjectRef(userId),
    revision,
  }) as DelegatedAuthorityRef
  delegatedAuthorityClaims.set(authority, Object.freeze({ userId, revision, source }))
  return authority
}

export class DelegatedOperationContextFactory implements DelegatedOperationContextFactoryPort {
  constructor(private readonly deps: OperationContextFactoryDeps) {}

  fromDurableAttempt(
    authority: DelegatedAuthorityRef,
    source: DelegatedSource,
    attempt: DurableSourceAttemptRef,
  ): IdempotentCommandContext {
    const claim = delegatedAuthorityClaims.get(authority)
    if (
      claim === undefined ||
      claim.source !== source ||
      claim.userId !== authority.subjectRef.userId ||
      claim.revision !== authority.revision
    ) {
      throw new Error('untrusted-delegated-authority')
    }
    const sourceId = durableAttemptPart(attempt.sourceId)
    const attemptId = durableAttemptPart(attempt.attemptId)
    const operationId = this.deps.id()
    const context: IdempotentCommandContext = Object.freeze({
      authority: mintRequestAuthority(claim.userId),
      operationId,
      correlationId: sourceId,
      causationId: attemptId,
      now: this.deps.now(),
      idempotencyKey: JSON.stringify([source, sourceId, attemptId]) as ValidatedIdempotencyKey,
    })
    contextMetadata.set(context, { source, transport: 'delegated' })
    return context
  }
}

function durableAttemptPart(value: string): string {
  if (value.length === 0 || value.length > 512 || value.trim() !== value) {
    throw new Error('invalid-durable-source-attempt')
  }
  return value
}
