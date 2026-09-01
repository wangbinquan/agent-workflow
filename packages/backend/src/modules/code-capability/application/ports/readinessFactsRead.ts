// RFC-349 — provider-owned observations used by the readiness application.

import type { CapabilityTriggerCandidate } from '../readinessFacts'
import type { RepoEndpointReadPort } from './repoEndpointRead'

export interface ReadinessFactsReadPort {
  readonly repoEndpoints: RepoEndpointReadPort
  templateExists(templateId: string): Promise<boolean>
  listCapabilityTriggers(input: {
    readonly endpointId: string
    readonly capability: string
  }): Promise<readonly CapabilityTriggerCandidate[]>
  agentSlotVisible(input: { readonly templateId: string; readonly slot: string }): Promise<boolean>
}
