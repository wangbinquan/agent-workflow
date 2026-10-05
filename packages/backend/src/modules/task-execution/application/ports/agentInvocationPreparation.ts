import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
  PreparedAgentMaterial,
} from '@/modules/runtime-management/public/participants'
import type { AgentInvocationBinding } from './agentInvocation'

/** One compilation owns both the declaration and its eventual invocation.
 * Binding stays at the caller's original invocation boundary, after its
 * material-prepare error handling. No native plan or target is exposed. */
export interface CompiledAgentInvocation extends PreparedAgentMaterial {
  bind(): AgentInvocationBinding
  /** Preserve the original material cleanup point if late binding fails. */
  cleanup?(): void | Promise<void>
}

/** Composition has already selected the compiler, content, workspace and
 * execution family. A caller supplies the complete AW material declaration. */
export interface AgentInvocationPreparation {
  readonly workspace: AgentMaterialWorkspace
  compile(intent: AgentMaterialIntent): Promise<CompiledAgentInvocation>
}
