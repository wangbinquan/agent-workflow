import type {
  AgentMaterialCompiler,
  AgentMaterialWorkspace,
  PreparedAgentMaterial,
} from '@/modules/runtime-management/public/participants'
import type { AgentInvocationBinding } from '../application/ports/agentInvocation'
import type { AgentInvocationPreparation } from '../application/ports/agentInvocationPreparation'

/** Capture an already selected implementation. Neither phase performs target
 * selection; the binding receives the exact result of the sole compilation. */
export function createAgentInvocationPreparation(input: {
  readonly compiler: AgentMaterialCompiler
  readonly workspace: AgentMaterialWorkspace
  readonly bind: (material: PreparedAgentMaterial) => AgentInvocationBinding
  readonly cleanupMaterial?: (material: PreparedAgentMaterial) => void | Promise<void>
}): AgentInvocationPreparation {
  const compiler = input.compiler
  const workspace = input.workspace
  const bind = input.bind
  const cleanupMaterial = input.cleanupMaterial
  return {
    workspace,
    async compile(intent) {
      const material = await compiler.compile(intent)
      let bound = false
      return {
        materialRef: material.materialRef,
        declared: material.declared,
        evidenceCapabilities: material.evidenceCapabilities,
        ...(cleanupMaterial === undefined
          ? {}
          : { cleanup: () => cleanupMaterial.call(input, material) }),
        bind() {
          if (bound) throw new Error('agent-invocation-material-already-bound')
          bound = true
          return bind.call(input, material)
        },
      }
    },
  }
}
