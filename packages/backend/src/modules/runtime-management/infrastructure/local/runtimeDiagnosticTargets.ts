import type { RuntimeKind } from '../../public/types'
import type { AgentMaterialContentReference } from '../../application/ports/agentMaterial'
import type { RuntimeDiagnosticTarget } from '../../application/ports/runtimeManagement'

/** Binary interpretation stays inside this selected native owner. Constructing
 * a target performs no driver lookup, configuration read or workspace effect. */
export function createLocalRuntimeDiagnosticTargets() {
  let nextReference = 0
  const binaries = new WeakMap<RuntimeDiagnosticTarget, string>()
  const references = new WeakMap<AgentMaterialContentReference, string>()
  function capture(input: {
    readonly protocol: () => RuntimeKind
    readonly binaryPath: string
  }): RuntimeDiagnosticTarget {
    const binary = input.binaryPath
    const runtimeBinding = Object.freeze<AgentMaterialContentReference>({
      owner: 'runtime-management',
      reference: `aw-runtime-diagnostic:${++nextReference}`,
      version: null,
    })
    const target = Object.freeze<RuntimeDiagnosticTarget>({
      get protocol() {
        return input.protocol()
      },
      label: binary,
      receiptKey: binary,
      runtimeBinding,
    })
    binaries.set(target, binary)
    references.set(runtimeBinding, binary)
    return target
  }
  function binary(target: RuntimeDiagnosticTarget): string {
    if (!binaries.has(target)) throw new Error('runtime-diagnostic-target-unavailable')
    return binaries.get(target)!
  }
  function runtimeBinding(target: RuntimeDiagnosticTarget): AgentMaterialContentReference {
    if (!binaries.has(target)) throw new Error('runtime-diagnostic-target-unavailable')
    return target.runtimeBinding
  }
  function runtimeBinary(reference: AgentMaterialContentReference): string {
    if (!references.has(reference)) throw new Error('runtime-diagnostic-binding-unavailable')
    return references.get(reference)!
  }
  return Object.freeze({
    capture,
    binary,
    runtimeBinding,
    contents: Object.freeze({ runtimeBinary }),
  })
}
