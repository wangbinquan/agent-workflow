// RFC-349 — provider-neutral facts used to resolve a repository's code host.

export type CodeHostProvider = 'gitlab' | 'github'

export interface EnabledCodeHostEndpoint {
  readonly id: string
  readonly provider: CodeHostProvider
}

export interface CodeHostConnectionFact {
  readonly provider: CodeHostProvider
  readonly baseUrl: string
  readonly repositoryUrlPrefixesJson: string
}

export interface RepoEndpointReadPort {
  listEnabledEndpoints(): Promise<readonly EnabledCodeHostEndpoint[]>
  readRepoUrl(repoId: string): Promise<string | null>
  listConnections(): Promise<readonly CodeHostConnectionFact[]>
}
