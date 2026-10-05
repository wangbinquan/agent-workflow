import type { DeclaredInjectionManifest } from '@agent-workflow/shared'
import type {
  AgentInvocationProtocol,
  AgentMaterialEvidence,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import type { AgentExecutionBinding, AgentExecutionParticipants } from './agentExecutionBinding'

/** The execution demand owns the joint invocation; runtime-management offers
 * only protocol, material, workspace and evidence. Composition pairs their
 * selected implementations with the execution owner's receipt dialect. */
export interface AgentInvocationBinding {
  readonly materialRef: string
  /** Legacy raw-plan fixtures can omit a declaration; never synthesize one. */
  readonly declared?: DeclaredInjectionManifest
  readonly protocol: AgentInvocationProtocol
  readonly workspace: AgentMaterialWorkspace
  readonly evidence: AgentMaterialEvidence
  readonly lifecycle: {
    readonly beforeStart?: () => void | Promise<void>
    readonly cleanup?: () => void | Promise<void>
  }
  bindExecution(participants?: AgentExecutionParticipants): AgentExecutionBinding
}
