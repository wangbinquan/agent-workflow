import { type SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createDevelopmentDeliveryProvider } from '@/modules/development-automation/composition'
import { createRepositoryEndpointDiscovery } from '@/modules/integration/composition'
import { composeSelectedPipelineEvidenceRunnerFor } from '@/modules/integration/composition/pipelineEvidence'
import {
  composeRepositoryTransportCredentials,
  createRepositoryPublicationTransport,
  type RepositoryTransportCredentialRepository,
  type RepositoryWorkspaceOperations,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import { createCodeHostConnectionsService } from '@/services/codeHost/connections'
import { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'

export function composeDaemonRepositoryCredentials(input: {
  readonly db: PersistenceDb
  readonly secretBox: SecretBox
  readonly appHome: string
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  readonly repositoryWorkspaceOperations: RepositoryWorkspaceOperations
  readonly repositoryTransportCredentialRepository: RepositoryTransportCredentialRepository
  readonly developmentPurposeRoot: {
    readonly pipeline: Parameters<typeof composeSelectedPipelineEvidenceRunnerFor>[1]
  }
  readonly repositoryPublicationTransport?: ReturnType<typeof createRepositoryPublicationTransport>
  readonly developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  readonly codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const repositoryWorkspaceStore = input.repositoryWorkspaceStore
  const repositoryWorkspaceOperations = input.repositoryWorkspaceOperations
  const repository = input.repositoryTransportCredentialRepository
  const repositoryTransport = composeRepositoryTransportCredentials(repository, input.secretBox)
  const codeHostConnections = createCodeHostConnectionsService({
    secretBox: input.secretBox,
    repositoryTransport: repositoryTransport.adminConnections,
  })
  const repositoryEndpointDiscovery = createRepositoryEndpointDiscovery({
    async resolveConnection(provider) {
      const connection = await codeHostConnections.resolve(provider)
      if (connection?.connectionGeneration === undefined) return null
      return {
        provider: connection.provider,
        apiBaseUrl: connection.baseUrl,
        connectionGeneration: connection.connectionGeneration,
        token: connection.token,
        rejectUnauthorized: connection.rejectUnauthorized,
      }
    },
    ...(input.codeHostFetch === undefined ? {} : { fetchImpl: input.codeHostFetch }),
  })
  const repositoryPublicationTransport =
    input.repositoryPublicationTransport ??
    createRepositoryPublicationTransport({
      repository,
      secretBox: input.secretBox,
      appHome: input.appHome,
      endpointDiscovery: repositoryEndpointDiscovery,
    })
  const developmentDeliveryProvider = createDevelopmentDeliveryProvider({
    db: input.db,
    secretBox: input.secretBox,
    connections: codeHostConnections,
    pipeline: composeSelectedPipelineEvidenceRunnerFor(
      input.db,
      input.developmentPurposeRoot.pipeline,
    ),
  })
  const developmentWorkspaceRepositoryPreparation =
    input.developmentWorkspaceRepositoryPreparation ??
    createDevelopmentWorkspaceRepositoryPreparation({
      store: repositoryWorkspaceStore,
      appHome: input.appHome,
      secretBox: input.secretBox,
    })
  return Object.freeze({
    repositoryWorkspaceStore,
    repositoryWorkspaceOperations,
    repositoryTransport,
    codeHostConnections,
    repositoryEndpointDiscovery,
    repositoryPublicationTransport,
    developmentDeliveryProvider,
    developmentWorkspaceRepositoryPreparation,
  })
}
export type DaemonRepositoryCredentials = ReturnType<typeof composeDaemonRepositoryCredentials>
