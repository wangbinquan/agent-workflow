import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialList,
  OwnCodeHostPushCredentialSummary,
  PutOwnCodeHostPushCredentialRequest,
  RepositoryCredentialSubject,
  TestOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import type { ResolvedAuthoritySubject } from '@/modules/identity-access/public/types'
import { selectRepositoryTransportCredential } from '../domain/repositoryTransportCredential'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportCredentialRepository,
  StoredRepositoryTransportConnection,
} from '../ports/repositoryTransportCredentialRepository'
import type { OwnRepositoryTransportCredentialCommands } from '../public/commands'
import type { OwnRepositoryTransportCredentialQueries } from '../public/queries'
import type { RepositoryTransportCredentialSelectionParticipant } from '../public/repositoryTransportParticipants'
import type { RepositoryTransportCredentialSelection } from '../public/types'

export interface ManagedCodeHostCredential {
  readonly provider: CodeHostProvider
  readonly baseUrl: string
  readonly repositoryUrlPrefixes: readonly string[]
  readonly transportMappings: StoredRepositoryTransportConnection['transportMappings']
  readonly connectionGeneration: string
  readonly endpointBindingDigest: string
  readonly token: string
  readonly rejectUnauthorized: boolean
  readonly credentialSource: 'personal' | 'global'
  readonly credentialRevision: number | null
}

export type ManagedCodeHostConnection = Omit<
  ManagedCodeHostCredential,
  'token' | 'credentialSource' | 'credentialRevision'
>

export type ManagedCodeHostCredentialResolution =
  | { readonly ok: true; readonly credential: ManagedCodeHostCredential }
  | {
      readonly ok: false
      readonly code:
        | 'code-host-push-credential-connection-missing'
        | 'code-host-push-credential-stale'
        | 'code-host-push-credential-unavailable'
    }

export type RepositoryTransportCredentialErrorKind = 'validation' | 'conflict' | 'not-found'

export class RepositoryTransportCredentialError extends Error {
  constructor(
    readonly kind: RepositoryTransportCredentialErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RepositoryTransportCredentialError'
  }
}

function hintOf(token: string): string {
  return token.slice(-4)
}

export class RepositoryTransportCredentials
  implements
    OwnRepositoryTransportCredentialCommands,
    OwnRepositoryTransportCredentialQueries,
    RepositoryTransportCredentialSelectionParticipant
{
  constructor(
    private readonly repository: RepositoryTransportCredentialRepository,
    private readonly secretBox: SecretBox,
  ) {}

  list(subject: ResolvedAuthoritySubject): OwnCodeHostPushCredentialList {
    const personal = new Map(
      this.repository.listPersonal(subject.userId).map((row) => [row.provider, row] as const),
    )
    return {
      items: [...this.repository.listConnections()]
        .sort((left, right) => left.provider.localeCompare(right.provider))
        .map((connection) =>
          this.repository.ownSummary(connection, personal.get(connection.provider) ?? null),
        ),
    }
  }

  /** Secret-free matching view used before a provider is known. */
  listExecutionConnections(): readonly ManagedCodeHostConnection[] {
    return this.repository
      .listConnections()
      .map((connection) => this.executionConnection(connection))
  }

  put(
    subject: ResolvedAuthoritySubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): OwnCodeHostPushCredentialSummary {
    if (request.token.length < 8 || request.token.length > 4096) {
      throw new RepositoryTransportCredentialError(
        'validation',
        'code-host-push-credential-invalid',
        'code-host push credential does not satisfy the input contract',
      )
    }
    const connection = this.repository.findConnection(provider)
    if (connection === null) {
      throw new RepositoryTransportCredentialError(
        'conflict',
        'code-host-push-credential-connection-missing',
        `${provider} has no configured code-host connection`,
      )
    }
    if (
      request.connectionGeneration !== connection.connectionGeneration ||
      request.endpointBindingDigest !== connection.endpointBindingDigest
    ) {
      throw new RepositoryTransportCredentialError(
        'conflict',
        'code-host-push-credential-stale',
        'the code-host connection changed; refresh before saving the credential',
      )
    }
    const personal = this.repository.putPersonal({
      userId: subject.userId,
      provider,
      connectionGeneration: connection.connectionGeneration,
      endpointBindingDigest: connection.endpointBindingDigest,
      tokenEnc: this.secretBox.seal(request.token),
      tokenHint: hintOf(request.token),
      now: Date.now(),
    })
    return this.repository.ownSummary(connection, personal)
  }

  remove(
    subject: ResolvedAuthoritySubject,
    provider: CodeHostProvider,
  ): { readonly removed: boolean } {
    return { removed: this.repository.removePersonal(subject.userId, provider) }
  }

  /**
   * The sole runtime credential supply for platform-owned Git transport.
   * Selection and unsealing live together so publication consumers cannot
   * implement their own fallback. Code-host REST operations continue to use
   * the administrator-managed global connection instead. A selected personal
   * credential never falls through to the global token when stale or corrupt.
   */
  resolveExecution(
    subject: RepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): ManagedCodeHostCredentialResolution {
    const connection = this.repository.findConnection(provider)
    if (connection === null) {
      return { ok: false, code: 'code-host-push-credential-connection-missing' }
    }
    const personal =
      subject.kind === 'user' ? this.repository.findPersonal(subject.userId, provider) : null
    const selected = selectRepositoryTransportCredential({
      subjectKind: subject.kind,
      binding: connection,
      personal,
      global: {
        credentialRef: `global:${connection.provider}:${connection.credentialRevision}`,
        connectionGeneration: connection.connectionGeneration,
        endpointBindingDigest: connection.endpointBindingDigest,
        credentialRevision: connection.credentialRevision,
      },
    })
    if (!selected.ok) return selected
    if (selected.source === 'legacy') {
      return { ok: false, code: 'code-host-push-credential-unavailable' }
    }
    let token: string
    try {
      token = this.secretBox.unseal(
        selected.source === 'personal' ? personal!.tokenEnc : connection.globalTokenEnc,
      )
    } catch {
      return { ok: false, code: 'code-host-push-credential-unavailable' }
    }
    return {
      ok: true,
      credential: this.executionCredential(
        connection,
        token,
        selected.source,
        selected.credentialRevision,
      ),
    }
  }

  /** Stored-personal or one-shot draft resolution for the account identity probe. */
  resolvePersonalForTest(
    subject: ResolvedAuthoritySubject,
    provider: CodeHostProvider,
    request: TestOwnCodeHostPushCredentialRequest,
  ): ManagedCodeHostCredentialResolution {
    const connection = this.repository.findConnection(provider)
    if (connection === null) {
      return { ok: false, code: 'code-host-push-credential-connection-missing' }
    }
    if (
      request.connectionGeneration !== connection.connectionGeneration ||
      request.endpointBindingDigest !== connection.endpointBindingDigest
    ) {
      return { ok: false, code: 'code-host-push-credential-stale' }
    }
    if (request.token !== undefined) {
      return {
        ok: true,
        credential: this.executionCredential(connection, request.token, 'personal', null),
      }
    }
    const personal = this.repository.findPersonal(subject.userId, provider)
    if (personal === null) {
      return { ok: false, code: 'code-host-push-credential-unavailable' }
    }
    const selected = selectRepositoryTransportCredential({
      subjectKind: 'user',
      binding: connection,
      personal,
      global: null,
    })
    if (!selected.ok) return selected
    if (selected.source !== 'personal') {
      return { ok: false, code: 'code-host-push-credential-unavailable' }
    }
    try {
      return {
        ok: true,
        credential: this.executionCredential(
          connection,
          this.secretBox.unseal(personal.tokenEnc),
          'personal',
          selected.credentialRevision,
        ),
      }
    } catch {
      return { ok: false, code: 'code-host-push-credential-unavailable' }
    }
  }

  private executionCredential(
    connection: StoredRepositoryTransportConnection,
    token: string,
    credentialSource: 'personal' | 'global',
    credentialRevision: number | null,
  ): ManagedCodeHostCredential {
    return {
      ...this.executionConnection(connection),
      token,
      credentialSource,
      credentialRevision,
    }
  }

  private executionConnection(
    connection: StoredRepositoryTransportConnection,
  ): ManagedCodeHostConnection {
    return {
      provider: connection.provider,
      baseUrl: connection.apiBaseUrl,
      repositoryUrlPrefixes: connection.allowedHttpBaseUrls,
      transportMappings: connection.transportMappings,
      connectionGeneration: connection.connectionGeneration,
      endpointBindingDigest: connection.endpointBindingDigest,
      rejectUnauthorized: connection.rejectUnauthorized,
    }
  }

  inspect(provider: CodeHostProvider) {
    const current = this.repository.findConnection(provider)
    return {
      personalCredentialCount: this.repository.personalCount(provider),
      currentConnectionGeneration: current?.connectionGeneration ?? null,
      currentEndpointBindingDigest: current?.endpointBindingDigest ?? null,
    }
  }

  synchronize(input: RepositoryTransportConnectionProjectionInput): void {
    this.repository.synchronizeConnection(input)
  }

  removeConnection(provider: CodeHostProvider): boolean {
    return this.repository.removeConnection(provider)
  }

  select(input: {
    readonly subject:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'system' }
    readonly provider: CodeHostProvider
  }): RepositoryTransportCredentialSelection {
    const connection = this.repository.findConnection(input.provider)
    const personal =
      input.subject.kind === 'user'
        ? this.repository.findPersonal(input.subject.userId, input.provider)
        : null
    return selectRepositoryTransportCredential({
      subjectKind: input.subject.kind,
      binding: connection,
      personal,
      global:
        connection === null
          ? null
          : {
              credentialRef: `global:${connection.provider}:${connection.credentialRevision}`,
              connectionGeneration: connection.connectionGeneration,
              endpointBindingDigest: connection.endpointBindingDigest,
              credentialRevision: connection.credentialRevision,
            },
    })
  }
}
