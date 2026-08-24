import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialSummary,
  RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
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

export interface RepositoryTransportCredentialRepository {
  listConnections(): readonly StoredRepositoryTransportConnection[]
  findConnection(provider: CodeHostProvider): StoredRepositoryTransportConnection | null
  findPersonal(
    userId: string,
    provider: CodeHostProvider,
  ): StoredPersonalRepositoryTransportCredential | null
  listPersonal(userId: string): readonly StoredPersonalRepositoryTransportCredential[]
  putPersonal(input: {
    readonly userId: string
    readonly provider: CodeHostProvider
    readonly connectionGeneration: string
    readonly endpointBindingDigest: string
    readonly tokenEnc: string
    readonly tokenHint: string
    readonly now: number
  }): StoredPersonalRepositoryTransportCredential
  removePersonal(userId: string, provider: CodeHostProvider): boolean
  personalCount(provider: CodeHostProvider): number
  synchronizeConnection(input: RepositoryTransportConnectionProjectionInput): void
  removeConnection(provider: CodeHostProvider): boolean
  ownSummary(
    connection: StoredRepositoryTransportConnection,
    personal: StoredPersonalRepositoryTransportCredential | null,
  ): OwnCodeHostPushCredentialSummary
}
