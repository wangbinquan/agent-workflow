// RFC-551 (RFC-294 S9): the provider metadata query repository endpoint resolution uses. They sat on `public/` without any other module consuming them.
import type { CodeHostProvider, RepositoryEndpointCandidate } from '@agent-workflow/shared'

/** Secret-free provider metadata query used by repository endpoint resolution. */
export interface RepositoryEndpointDiscoveryParticipant {
  discover(input: {
    readonly provider: CodeHostProvider
    readonly project: string
    readonly connectionGeneration: string
  }): Promise<RepositoryEndpointCandidate | null>
}
