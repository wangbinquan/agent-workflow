import { type SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createDevelopmentDeliveryProvider } from '@/modules/development-automation/composition'
import {
  codeHostRequests,
  composeCodeHostConnections,
  createRepositoryEndpointDiscovery,
} from '@/modules/integration/composition'
import { composeSelectedPipelineEvidenceRunnerFor } from '@/modules/integration/composition/pipelineEvidence'
import { composeDevelopmentCodeHostDelivery } from '@/modules/integration/composition/codeHostEffects'
import {
  composeRepositoryTransportCredentials,
  type RepositoryTransportCredentialRepository,
  type RepositoryWorkspaceOperations,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import type { DeploymentSelections } from '../deploymentProfile'

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
  // RFC-432: the deployment's session factories, called once the bundle's own services exist.
  readonly repositoryPublicationTransport: DeploymentSelections['repositoryPublicationTransport']
  readonly developmentWorkspaceRepositoryPreparation: DeploymentSelections['developmentWorkspaceRepositoryPreparation']
  readonly codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const repositoryWorkspaceStore = input.repositoryWorkspaceStore
  const repositoryWorkspaceOperations = input.repositoryWorkspaceOperations
  const repository = input.repositoryTransportCredentialRepository
  const repositoryTransport = composeRepositoryTransportCredentials(repository, input.secretBox)
  const codeHostConnections = composeCodeHostConnections({
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
  const repositoryPublicationTransport = input.repositoryPublicationTransport({
    repository,
    secretBox: input.secretBox,
    appHome: input.appHome,
    endpointDiscovery: repositoryEndpointDiscovery,
  })
  const developmentDeliveryProvider = createDevelopmentDeliveryProvider({
    db: input.db,
    secretBox: input.secretBox,
    pipeline: composeSelectedPipelineEvidenceRunnerFor(
      input.db,
      input.developmentPurposeRoot.pipeline,
    ),
  })
  // RFC-471: integration binds a repository to its code host from the delivery provider's remotes; the
  // MR effects, raw MR facts and claim keys built on that binding are injected into development automation.
  const developmentCodeHost = composeDevelopmentCodeHostDelivery({
    repositories: {
      resolve: (repositoryId) => developmentDeliveryProvider.resolveRepository(repositoryId),
    },
    connections: codeHostConnections,
    // RFC-450: every resolved MR binding sends through integration's code-host requests.
    requests: codeHostRequests,
  })
  const developmentWorkspaceRepositoryPreparation = input.developmentWorkspaceRepositoryPreparation(
    {
      store: repositoryWorkspaceStore,
      appHome: input.appHome,
      secretBox: input.secretBox,
    },
  )
  return Object.freeze({
    repositoryWorkspaceStore,
    repositoryWorkspaceOperations,
    repositoryTransport,
    codeHostConnections,
    repositoryEndpointDiscovery,
    repositoryPublicationTransport,
    developmentDeliveryProvider,
    developmentCodeHost,
    developmentWorkspaceRepositoryPreparation,
  })
}
export type DaemonRepositoryCredentials = ReturnType<typeof composeDaemonRepositoryCredentials>
