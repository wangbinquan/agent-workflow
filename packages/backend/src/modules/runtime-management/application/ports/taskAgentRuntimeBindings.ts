import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'
import type { RuntimeKind, RuntimeObservationIdentity, RuntimeProfile } from '../../public/types'
import type { AgentMaterialContentReference } from './agentMaterial'

/** Business snapshot of a node run. Only the selected runtime owner can
 * interpret its binding; a null binding retains the protocol default. */
export interface FrozenTaskAgentRuntime {
  readonly protocol: RuntimeKind
  readonly runtimeBinding: AgentMaterialContentReference | null
  readonly params: RuntimeProfile
  readonly configDir: RuntimeConfigDirProfile
  readonly observationIdentity?: RuntimeObservationIdentity
}

export interface TaskAgentRuntimeBindings {
  resolve(
    nodeRunId: string,
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
    inheritFrom?: FrozenTaskAgentRuntime | null,
  ): Promise<FrozenTaskAgentRuntime>
  ofSession(sessionId: string): Promise<FrozenTaskAgentRuntime | null>
  internal(input: {
    readonly runtimeName?: string | null
    readonly deprecatedModel?: string | null
    readonly defaultRuntime?: string | null
  }): Promise<FrozenTaskAgentRuntime>
}
