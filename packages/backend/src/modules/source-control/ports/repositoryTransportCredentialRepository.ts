import type { CodeHostProvider, RepositoryTransportMappingV1 } from '@agent-workflow/shared'
import type {
  RepositoryTransportBinding,
  RepositoryTransportCredentialCandidate,
} from '../domain/repositoryTransportCredential'

export interface StoredRepositoryTransportConnection extends RepositoryTransportBinding {
  readonly apiBaseUrl: string
  readonly rejectUnauthorized: boolean
  readonly transportMappings: readonly RepositoryTransportMappingV1[]
  readonly allowedHttpBaseUrls: readonly string[]
  readonly globalTokenEnc: string
  readonly globalTokenHint: string
  readonly credentialRevision: number
  readonly updatedAt: number
  readonly updatedBy: string | null
}

export interface StoredPersonalRepositoryTransportCredential extends RepositoryTransportCredentialCandidate {
  readonly userId: string
  readonly provider: CodeHostProvider
  readonly tokenEnc: string
  readonly tokenHint: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RepositoryTransportConnectionProjectionInput {
  readonly provider: CodeHostProvider
  readonly connectionGeneration: string
  readonly endpointBindingDigest: string
  readonly apiBaseUrl: string
  readonly rejectUnauthorized: boolean
  readonly transportMappings: readonly RepositoryTransportMappingV1[]
  readonly allowedHttpBaseUrls: readonly string[]
  readonly globalTokenEnc: string
  readonly globalTokenHint: string
  readonly updatedAt: number
  readonly updatedBy: string | null
}

/**
 * Ciphertext-only administrator connection row used to converge the
 * source-control-owned publication projection at boot. Infrastructure owns
 * the physical table lookup; composition only sees this closed record.
 */
export interface RepositoryTransportConnectionProjectionSource {
  readonly provider: CodeHostProvider
  readonly connectionGeneration: string
  readonly baseUrl: string
  readonly rejectUnauthorized: boolean
  readonly repositoryUrlPrefixesJson: string
  readonly transportMappingsJson: string
  readonly tokenEnc: string
  readonly tokenHint: string
  readonly lastTestJson: string | null
  readonly updatedAt: number
  readonly updatedBy: string | null
}

export interface RepositoryTransportConnectionMutationFence {
  readonly personalCredentialCount: number
  readonly currentConnectionGeneration: string | null
  readonly currentEndpointBindingDigest: string | null
}

export interface RepositoryTransportCredentialRepository {
  listConnections(): Promise<readonly StoredRepositoryTransportConnection[]>
  findConnection(provider: CodeHostProvider): Promise<StoredRepositoryTransportConnection | null>
  findPersonal(
    userId: string,
    provider: CodeHostProvider,
  ): Promise<StoredPersonalRepositoryTransportCredential | null>
  listPersonal(userId: string): Promise<readonly StoredPersonalRepositoryTransportCredential[]>
  putPersonal(input: {
    readonly userId: string
    readonly provider: CodeHostProvider
    readonly connectionGeneration: string
    readonly endpointBindingDigest: string
    readonly tokenEnc: string
    readonly tokenHint: string
    readonly now: number
  }): Promise<StoredPersonalRepositoryTransportCredential>
  removePersonal(userId: string, provider: CodeHostProvider): Promise<boolean>
  personalCount(provider: CodeHostProvider): Promise<number>
  listConfiguredConnections(): Promise<readonly RepositoryTransportConnectionProjectionSource[]>
  findConfiguredConnection(
    provider: CodeHostProvider,
  ): Promise<RepositoryTransportConnectionProjectionSource | null>
  synchronizeConfiguredConnection(
    connection: RepositoryTransportConnectionProjectionSource,
    projection: RepositoryTransportConnectionProjectionInput,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<boolean>
  removeConfiguredConnection(
    provider: CodeHostProvider,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<'removed' | 'missing' | 'stale'>
  recordConfiguredConnectionTest(provider: CodeHostProvider, lastTestJson: string): Promise<void>
  synchronizeConnection(input: RepositoryTransportConnectionProjectionInput): Promise<void>
  removeConnection(provider: CodeHostProvider): Promise<boolean>
}
