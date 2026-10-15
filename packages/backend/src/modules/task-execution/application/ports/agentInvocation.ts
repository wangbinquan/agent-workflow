import type { DeclaredInjectionManifest } from '@agent-workflow/shared'
import type {
  AgentInvocationProtocol,
  AgentMaterialEvidence,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import type {
  AgentExecutionOutcome,
  AgentExecutionRequest,
  AgentExecutionSink,
} from './agentExecution'

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
  /** RFC-370 v2 §3.3: run this invocation once, delivering interpreted
   * records to the sink. The selected implementation owns its transport. */
  execute(request: AgentExecutionRequest, sink: AgentExecutionSink): Promise<AgentExecutionOutcome>
}
