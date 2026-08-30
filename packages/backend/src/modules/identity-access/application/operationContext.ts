import type {
  AdmittedDaemonCredential,
  AdmittedPatCredential,
  AdmittedSessionCredential,
  AuthenticatedPrincipal,
  AuthorizationSubjectRef,
  CommandContext,
  CurrentSubjectAccessResolver,
  DelegatedAuthorityAdmission,
  DelegatedRequestAuthority,
  DelegatedRequestAuthorityFactory,
  DelegatedSource,
  DirectAuthenticatedAuthority,
  DirectAuthorityAdmission,
  DirectAuthorityBinding,
  DirectAuthorityIdentity,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
  DirectRequestAuthority,
  DirectTransport,
  IdempotentCommandContext,
  LegacyActorProjection,
  PrincipalSource,
  QueryContext,
  RequestAuthority,
  ValidatedIdempotencyKey,
} from '../public/participants'
import { projectDelegatedLegacyActor, projectDirectLegacyActor } from './legacyActorProjection'

const SYSTEM_USER_ID = '__system__'

export type {
  AdmittedDaemonCredential,
  AdmittedPatCredential,
  AdmittedSessionCredential,
  AuthenticatedPrincipal,
  AuthorizationSubjectRef,
  CommandContext,
  DelegatedAuthorityAdmission,
  DelegatedRequestAuthority,
  DelegatedSource,
  DirectAuthenticatedAuthority,
  DirectAuthorityIdentity,
  DirectRequestAuthority,
  DirectTransport,
  IdempotentCommandContext,
  LegacyActorProjection,
  PrincipalSource,
  QueryContext,
  RequestAuthority,
  ValidatedIdempotencyKey,
} from '../public/participants'

interface TrustedContextMetadata {
  readonly source: PrincipalSource | DelegatedSource
  readonly transport: DirectTransport | 'delegated'
}

interface DelegatedClaim {
  readonly userId: string
  readonly revision: number
  readonly source: Extract<
    DelegatedSource,
    'schedule' | 'webhook' | 'call-workflow' | 'call-workgroup'
  >
  readonly actor: LegacyActorProjection
  readonly correlationId: string
  readonly attemptId?: string
}

const authoritySubjectResolver = Symbol('identity-access.authority-subject-resolver')
const contextMetadataResolver = Symbol('identity-access.context-metadata-resolver')

type InternallyOwnedAuthority = RequestAuthority & {
  readonly [authoritySubjectResolver]?: () => AuthorizationSubjectRef
}
type InternallyOwnedContext = (CommandContext | QueryContext) & {
  readonly [contextMetadataResolver]?: () => TrustedContextMetadata
}
function subjectRef(userId: string): AuthorizationSubjectRef {
  return Object.freeze({ userId }) as AuthorizationSubjectRef
}

/** Every runtime owns these WeakMaps.  The non-enumerable resolver closes over
 * the owning instance so application use cases can validate a handle without a
 * process-global registry. */
export class AuthorityClaimRegistry {
  private readonly authorityClaims = new WeakMap<RequestAuthority, AuthorizationSubjectRef>()
  private readonly directClaims = new WeakMap<
    DirectRequestAuthority,
    Readonly<{ principal: AuthenticatedPrincipal; actor: DirectAuthenticatedAuthority }>
  >()
  private readonly authorityByProjection = new WeakMap<object, DirectRequestAuthority>()
  private readonly delegatedClaims = new WeakMap<DelegatedRequestAuthority, DelegatedClaim>()
  private readonly contextMetadata = new WeakMap<object, TrustedContextMetadata>()

  mintLocalAuthority(principal: AuthenticatedPrincipal): RequestAuthority {
    return this.mintAuthority<RequestAuthority>(principal.userId)
  }

  mintDirectAuthority(
    principal: AuthenticatedPrincipal,
    actor: DirectAuthenticatedAuthority,
  ): DirectAuthorityIdentity {
    const authority = this.mintAuthority<DirectRequestAuthority>(principal.userId)
    this.directClaims.set(authority, Object.freeze({ principal, actor }))
    this.authorityByProjection.set(actor, authority)
    return Object.freeze({ authority, actor })
  }

  mintDelegatedAuthority(claim: DelegatedClaim): DelegatedRequestAuthority {
    const authority = this.mintAuthority<DelegatedRequestAuthority>(claim.userId)
    this.delegatedClaims.set(authority, Object.freeze(claim))
    return authority
  }

  directClaim(authority: DirectRequestAuthority) {
    const claim = this.directClaims.get(authority)
    if (claim === undefined) throw new Error('foreign-direct-request-authority')
    return claim
  }

  directAuthorityForProjection(projection: object): DirectRequestAuthority {
    const authority = this.authorityByProjection.get(projection)
    if (authority === undefined) throw new Error('foreign-legacy-actor-projection')
    return authority
  }

  delegatedClaim(authority: DelegatedRequestAuthority): DelegatedClaim {
    const claim = this.delegatedClaims.get(authority)
    if (claim === undefined) throw new Error('foreign-delegated-request-authority')
    return claim
  }

  mintContext<T extends CommandContext | QueryContext>(
    value: T,
    metadata: TrustedContextMetadata,
  ): T {
    const context = value as T & Record<PropertyKey, unknown>
    Object.defineProperty(context, contextMetadataResolver, {
      enumerable: false,
      value: () => {
        const found = this.contextMetadata.get(context)
        if (found === undefined) throw new Error('untrusted-operation-context')
        return found
      },
    })
    this.contextMetadata.set(context, Object.freeze(metadata))
    return Object.freeze(context) as T
  }

  private mintAuthority<T extends RequestAuthority>(userId: string): T {
    const handle = {} as T & Record<PropertyKey, unknown>
    Object.defineProperty(handle, authoritySubjectResolver, {
      enumerable: false,
      value: () => {
        const found = this.authorityClaims.get(handle)
        if (found === undefined) throw new Error('untrusted-request-authority')
        return found
      },
    })
    this.authorityClaims.set(handle, subjectRef(userId))
    return Object.freeze(handle) as T
  }
}

export function subjectRefOf(authority: RequestAuthority): AuthorizationSubjectRef {
  const resolver = (authority as InternallyOwnedAuthority)[authoritySubjectResolver]
  if (typeof resolver !== 'function') throw new Error('untrusted-request-authority')
  return resolver()
}

export interface OperationContextFactoryDeps {
  readonly id: () => string
  readonly now: () => number
}

export class DirectAuthorityRuntime implements DirectAuthorityAdmission, DirectAuthorityBinding {
  constructor(
    private readonly currentSubjects: CurrentSubjectAccessResolver,
    private readonly registry: AuthorityClaimRegistry,
  ) {}

  fromSession(credential: AdmittedSessionCredential): Promise<DirectAuthorityIdentity | null> {
    return this.admit(credential.userId, { source: 'session' })
  }

  fromPat(credential: AdmittedPatCredential): Promise<DirectAuthorityIdentity | null> {
    return this.admit(credential.userId, {
      source: 'pat',
      patScopes: credential.scopes,
      patPurpose: credential.purpose,
      patId: credential.patId,
    })
  }

  fromDaemon(_credential: AdmittedDaemonCredential): Promise<DirectAuthorityIdentity | null> {
    return this.admit(SYSTEM_USER_ID, { source: 'daemon' })
  }

  private async admit(
    userId: string,
    input: Parameters<typeof projectDirectLegacyActor>[1],
  ): Promise<DirectAuthorityIdentity | null> {
    const current = await this.currentSubjects.resolveCurrentSubject(userId)
    if (current === null) return null
    return this.registry.mintDirectAuthority(
      Object.freeze({ userId: current.userId, source: input.source }),
      projectDirectLegacyActor(current, input),
    )
  }

  authorityForLegacyProjection(projection: object): DirectRequestAuthority {
    return this.registry.directAuthorityForProjection(projection)
  }

  legacyProjectionForAuthority(authority: DirectRequestAuthority): DirectAuthenticatedAuthority {
    return this.registry.directClaim(authority).actor
  }
}

export class DirectOperationContextFactory
  implements DirectCommandContextFactory, DirectQueryContextFactory
{
  constructor(
    private readonly deps: OperationContextFactoryDeps,
    private readonly registry: AuthorityClaimRegistry,
  ) {}

  fromAuthority(
    authority: DirectRequestAuthority,
    transport: DirectTransport,
    at?: number,
  ): CommandContext {
    const claim = this.registry.directClaim(authority)
    return this.command(authority, claim.principal.source, transport, at)
  }

  fromAuthorityWithIdempotency(
    authority: DirectRequestAuthority,
    transport: DirectTransport,
    key: ValidatedIdempotencyKey,
  ): IdempotentCommandContext {
    const claim = this.registry.directClaim(authority)
    const operationId = this.deps.id()
    return this.registry.mintContext<IdempotentCommandContext>(
      {
        authority,
        operationId,
        correlationId: operationId,
        now: this.deps.now(),
        idempotencyKey: key,
      },
      { source: claim.principal.source, transport },
    )
  }

  queryFromAuthority(authority: DirectRequestAuthority, transport: DirectTransport): QueryContext {
    const claim = this.registry.directClaim(authority)
    const operationId = this.deps.id()
    return this.registry.mintContext<QueryContext>(
      { authority, operationId, correlationId: operationId },
      { source: claim.principal.source, transport },
    )
  }

  resolveCommandContext(context: CommandContext): AuthenticatedPrincipal {
    const metadata = trustedContextMetadata(context)
    if (metadata.transport === 'delegated') throw new Error('direct-command-context-required')
    return Object.freeze({
      userId: subjectRefOf(context.authority).userId,
      source: metadata.source as PrincipalSource,
    })
  }

  resolveQueryContext(context: QueryContext): AuthenticatedPrincipal {
    const metadata = trustedContextMetadata(context)
    if (metadata.transport === 'delegated') throw new Error('direct-query-context-required')
    return Object.freeze({
      userId: subjectRefOf(context.authority).userId,
      source: metadata.source as PrincipalSource,
    })
  }

  /** Explicit local/test fixture surface.  It is intentionally absent from
   * the public Direct*ContextFactory contracts and has no production HTTP/MCP
   * consumer after RFC-347. */
  fromAuthenticatedPrincipal(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
    at?: number,
  ): CommandContext {
    return this.command(
      this.registry.mintLocalAuthority(principal),
      principal.source,
      transport,
      at,
    )
  }

  fromAuthenticatedPrincipalWithIdempotency(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
    key: ValidatedIdempotencyKey,
  ): IdempotentCommandContext {
    const authority = this.registry.mintLocalAuthority(principal)
    const operationId = this.deps.id()
    return this.registry.mintContext<IdempotentCommandContext>(
      {
        authority,
        operationId,
        correlationId: operationId,
        now: this.deps.now(),
        idempotencyKey: key,
      },
      { source: principal.source, transport },
    )
  }

  queryFromAuthenticatedPrincipal(
    principal: AuthenticatedPrincipal,
    transport: DirectTransport,
  ): QueryContext {
    const authority = this.registry.mintLocalAuthority(principal)
    const operationId = this.deps.id()
    return this.registry.mintContext<QueryContext>(
      { authority, operationId, correlationId: operationId },
      { source: principal.source, transport },
    )
  }

  private command(
    authority: RequestAuthority,
    source: PrincipalSource,
    transport: DirectTransport,
    at?: number,
  ): CommandContext {
    const operationId = this.deps.id()
    return this.registry.mintContext<CommandContext>(
      {
        authority,
        operationId,
        correlationId: operationId,
        now: at ?? this.deps.now(),
      },
      { source, transport },
    )
  }
}

/** Composition-only local operator participant. It resolves the selected
 * account once for the short-lived CLI process, but never mints an ordinary
 * session/PAT/daemon DirectRequestAuthority. */
export interface LocalOperatorIdentity {
  readonly actor: LegacyActorProjection
  commandContext(at?: number): CommandContext
  queryContext(): QueryContext
}

export class LocalOperatorContextFactory {
  constructor(
    private readonly currentSubjects: CurrentSubjectAccessResolver,
    private readonly contexts: DirectOperationContextFactory,
  ) {}

  async forUser(userId: string): Promise<LocalOperatorIdentity | null> {
    const current = await this.currentSubjects.resolveCurrentSubject(userId)
    if (current === null) return null
    const actor = projectDelegatedLegacyActor(current)
    const principal = Object.freeze({ userId: current.userId, source: 'cli' as const })
    return Object.freeze({
      actor,
      commandContext: (at?: number) =>
        this.contexts.fromAuthenticatedPrincipal(principal, 'cli', at),
      queryContext: () => this.contexts.queryFromAuthenticatedPrincipal(principal, 'cli'),
    })
  }
}

export function trustedContextMetadata(
  context: CommandContext | QueryContext,
): TrustedContextMetadata {
  const resolver = (context as InternallyOwnedContext)[contextMetadataResolver]
  if (typeof resolver !== 'function') throw new Error('untrusted-operation-context')
  return resolver()
}

export class DelegatedOperationContextFactory implements DelegatedRequestAuthorityFactory {
  constructor(
    private readonly deps: OperationContextFactoryDeps,
    private readonly currentSubjects: CurrentSubjectAccessResolver,
    private readonly registry: AuthorityClaimRegistry,
  ) {}

  forSchedule(input: {
    readonly ownerUserId: string
    readonly scheduleId: string
    readonly invocation:
      | { readonly kind: 'automatic'; readonly occurrenceAt: number }
      | { readonly kind: 'manual' }
  }): Promise<DelegatedAuthorityAdmission | null> {
    return this.admit({
      userId: input.ownerUserId,
      source: 'schedule',
      correlationId: input.scheduleId,
      ...(input.invocation.kind === 'automatic'
        ? { attemptId: String(input.invocation.occurrenceAt) }
        : {}),
    })
  }

  forWebhook(input: {
    readonly ownerUserId: string
    readonly triggerId: string
    readonly deliveryId: string
    readonly fireId: string
  }): Promise<DelegatedAuthorityAdmission | null> {
    return this.admit({
      userId: input.ownerUserId,
      source: 'webhook',
      correlationId: JSON.stringify([input.triggerId, input.deliveryId]),
      attemptId: input.fireId,
    })
  }

  forCall(input: {
    readonly kind: 'call-workflow' | 'call-workgroup'
    readonly ownerUserId: string
    readonly parentTaskId: string
    readonly parentNodeRunId: string
  }): Promise<DelegatedAuthorityAdmission | null> {
    return this.admit({
      userId: input.ownerUserId,
      source: input.kind,
      correlationId: input.parentTaskId,
      attemptId: input.parentNodeRunId,
    })
  }

  fromAuthority(authority: DelegatedRequestAuthority): CommandContext | IdempotentCommandContext {
    const claim = this.registry.delegatedClaim(authority)
    const operationId = this.deps.id()
    const common = {
      authority,
      operationId,
      correlationId: claim.correlationId,
      now: this.deps.now(),
    }
    if (claim.attemptId === undefined) {
      return this.registry.mintContext<CommandContext>(common, {
        source: claim.source,
        transport: 'delegated',
      })
    }
    const attemptId = durableAttemptPart(claim.attemptId)
    return this.registry.mintContext<IdempotentCommandContext>(
      {
        ...common,
        causationId: attemptId,
        idempotencyKey: JSON.stringify([
          claim.source,
          durableAttemptPart(claim.correlationId),
          attemptId,
        ]) as ValidatedIdempotencyKey,
      },
      { source: claim.source, transport: 'delegated' },
    )
  }

  private async admit(
    claim: Omit<DelegatedClaim, 'revision' | 'actor'>,
  ): Promise<DelegatedAuthorityAdmission | null> {
    const current = await this.currentSubjects.resolveCurrentSubject(claim.userId)
    if (current === null) return null
    const authority = this.registry.mintDelegatedAuthority({
      ...claim,
      userId: current.userId,
      revision: current.accessRevision,
      actor: projectDelegatedLegacyActor(current),
    })
    const registered = this.registry.delegatedClaim(authority)
    return Object.freeze({
      authority,
      actor: registered.actor,
      context: this.fromAuthority(authority),
    })
  }
}

function durableAttemptPart(value: string): string {
  if (value.length === 0 || value.length > 512 || value.trim() !== value) {
    throw new Error('invalid-durable-source-attempt')
  }
  return value
}
