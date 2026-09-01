import type {
  CodeHostProvider,
  CodeHostTestResult,
  OwnCodeHostPushCredentialList,
  OwnCodeHostPushCredentialSummary,
  PutOwnCodeHostPushCredentialRequest,
  RepositoryCredentialSubject,
  TestOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import { selectRepositoryTransportCredential } from '../domain/repositoryTransportCredential'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportConnectionMutationFence,
  RepositoryTransportConnectionProjectionSource,
  RepositoryTransportCredentialRepository,
  StoredRepositoryTransportConnection,
} from '../ports/repositoryTransportCredentialRepository'
import type { OwnRepositoryTransportCredentialCommands } from '../public/commands'
import type { OwnRepositoryTransportCredentialQueries } from '../public/queries'
import type { RepositoryTransportCredentialSelectionParticipant } from '../public/participants'
import {
  RepositoryTransportCredentialError,
  type OwnRepositoryCredentialSubject,
  type RepositoryTransportCredentialSelection,
} from '../public/types'
import { buildRepositoryTransportConnectionProjection } from './repositoryTransportConnectionProjection'

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

  async list(subject: OwnRepositoryCredentialSubject): Promise<OwnCodeHostPushCredentialList> {
    const personal = new Map(
      (await this.repository.listPersonal(subject.userId)).map(
        (row) => [row.provider, row] as const,
      ),
    )
    return {
      items: [...(await this.repository.listConnections())]
        .sort((left, right) => left.provider.localeCompare(right.provider))
        .map((connection) =>
          this.ownSummary(connection, personal.get(connection.provider) ?? null),
        ),
    }
  }

  /** Secret-free matching view used before a provider is known. */
  async listExecutionConnections(): Promise<readonly ManagedCodeHostConnection[]> {
    return (await this.repository.listConnections()).map((connection) =>
      this.executionConnection(connection),
    )
  }

  async put(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): Promise<OwnCodeHostPushCredentialSummary> {
    if (request.token.length < 8 || request.token.length > 4096) {
      throw new RepositoryTransportCredentialError(
        'validation',
        'code-host-push-credential-invalid',
        'code-host push credential does not satisfy the input contract',
      )
    }
    const connection = await this.repository.findConnection(provider)
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
    const personal = await this.repository.putPersonal({
      userId: subject.userId,
      provider,
      connectionGeneration: connection.connectionGeneration,
      endpointBindingDigest: connection.endpointBindingDigest,
      tokenEnc: this.secretBox.seal(request.token),
      tokenHint: hintOf(request.token),
      now: Date.now(),
    })
    return this.ownSummary(connection, personal)
  }

  async remove(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): Promise<{ readonly removed: boolean }> {
    return { removed: await this.repository.removePersonal(subject.userId, provider) }
  }

  /**
   * The sole runtime credential supply for platform-owned Git transport.
   * Selection and unsealing live together so publication consumers cannot
   * implement their own fallback. Code-host REST operations continue to use
   * the administrator-managed global connection instead. A selected personal
   * credential never falls through to the global token when stale or corrupt.
   */
  async resolveExecution(
    subject: RepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): Promise<ManagedCodeHostCredentialResolution> {
    const connection = await this.repository.findConnection(provider)
    if (connection === null) {
      return { ok: false, code: 'code-host-push-credential-connection-missing' }
    }
    const personal =
      subject.kind === 'user' ? await this.repository.findPersonal(subject.userId, provider) : null
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
  async resolvePersonalForTest(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: TestOwnCodeHostPushCredentialRequest,
  ): Promise<ManagedCodeHostCredentialResolution> {
    const connection = await this.repository.findConnection(provider)
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
    const personal = await this.repository.findPersonal(subject.userId, provider)
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

  private ownSummary(
    connection: StoredRepositoryTransportConnection,
    personal: Awaited<ReturnType<RepositoryTransportCredentialRepository['findPersonal']>>,
  ): OwnCodeHostPushCredentialSummary {
    return {
      provider: connection.provider,
      displayBaseUrl: connection.apiBaseUrl,
      connectionGeneration: connection.connectionGeneration,
      endpointBindingDigest: connection.endpointBindingDigest,
      configured: personal !== null,
      tokenHint: personal?.tokenHint ?? null,
      updatedAt: personal?.updatedAt ?? null,
      stale:
        personal !== null &&
        (personal.connectionGeneration !== connection.connectionGeneration ||
          personal.endpointBindingDigest !== connection.endpointBindingDigest),
      fallback: 'platform-global',
    }
  }

  async listAdminConnections(): Promise<readonly RepositoryTransportConnectionProjectionSource[]> {
    return await this.repository.listConfiguredConnections()
  }

  async findAdminConnection(
    provider: CodeHostProvider,
  ): Promise<RepositoryTransportConnectionProjectionSource | null> {
    return await this.repository.findConfiguredConnection(provider)
  }

  async inspectAdminConnection(provider: CodeHostProvider) {
    return await this.inspect(provider)
  }

  projectAdminConnection(input: RepositoryTransportConnectionProjectionSource) {
    return buildRepositoryTransportConnectionProjection(input)
  }

  async synchronizeAdminConnection(
    input: RepositoryTransportConnectionProjectionSource,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<boolean> {
    return await this.repository.synchronizeConfiguredConnection(
      input,
      buildRepositoryTransportConnectionProjection(input),
      expected,
    )
  }

  async removeAdminConnection(
    provider: CodeHostProvider,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<'removed' | 'missing' | 'stale'> {
    return await this.repository.removeConfiguredConnection(provider, expected)
  }

  async recordAdminConnectionTest(
    provider: CodeHostProvider,
    result: CodeHostTestResult,
  ): Promise<void> {
    await this.repository.recordConfiguredConnectionTest(provider, JSON.stringify(result))
  }

  async inspect(provider: CodeHostProvider) {
    const [current, personalCredentialCount] = await Promise.all([
      this.repository.findConnection(provider),
      this.repository.personalCount(provider),
    ])
    return {
      personalCredentialCount,
      currentConnectionGeneration: current?.connectionGeneration ?? null,
      currentEndpointBindingDigest: current?.endpointBindingDigest ?? null,
    }
  }

  async synchronize(input: RepositoryTransportConnectionProjectionInput): Promise<void> {
    await this.repository.synchronizeConnection(input)
  }

  async removeConnection(provider: CodeHostProvider): Promise<boolean> {
    return await this.repository.removeConnection(provider)
  }

  async select(input: {
    readonly subject:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'system' }
    readonly provider: CodeHostProvider
  }): Promise<RepositoryTransportCredentialSelection> {
    const connection = await this.repository.findConnection(input.provider)
    const personal =
      input.subject.kind === 'user'
        ? await this.repository.findPersonal(input.subject.userId, input.provider)
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
