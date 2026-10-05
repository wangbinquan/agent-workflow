import type { DeclaredInjectionManifest } from '@agent-workflow/shared'
import type {
  AgentExecutionBinding,
  AgentExecutionParticipants,
} from '@/modules/task-execution/public/participants'
import type { AgentMaterialEvidence } from './agentMaterialEvidence'
import type { AgentMaterialWorkspace } from './agentMaterialWorkspace'
import type { RuntimeKind } from '../../public/types'
import type {
  NormalizedEvent,
  RuntimeDriverCapabilities,
  SystemEventObservation,
} from '@/services/runtime/types'
import type { RuntimeUsageContext, RuntimeUsageFrame } from '@/services/runtime/usage'

/** Pure protocol behavior; selecting it does not select an execution target. */
export interface AgentInvocationProtocol {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeDriverCapabilities
  parseEvent(line: string): NormalizedEvent | null
  normalizeUsage?(raw: unknown, context: RuntimeUsageContext): RuntimeUsageFrame
  observeSystemEvent?(line: string): SystemEventObservation
  parseTerminalResultError?(line: string): string | null
}

/** A closed invocation keeps material, evidence, workspace and execution on
 * the same selected implementation. No command, environment, PID or host
 * location is part of this contract. Compilation and root selection remain
 * separate responsibilities; this is not a RuntimeDriver replacement. */
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
