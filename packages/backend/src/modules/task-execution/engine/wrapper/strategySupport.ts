import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { NodeStepOutcome } from '../../domain/nodeExecution'
import type { WrapperSettlement } from '../../domain/wrapperExecution'

export interface WrapperOutputBinding {
  readonly name: string
  readonly bind: { readonly nodeId: string; readonly portName: string }
}

/**
 * RFC-354 (schema v6) — a wrapper's RETURN VALUES are its `wrapper-output`
 * boundary edges: `body port → (wrapper, return port)`. One binding per edge,
 * in edge order (a return port bound twice keeps its first edge, the validator
 * rejects the duplicate).
 */
export function wrapperOutputBindings(
  definition: WorkflowDefinition,
  wrapperId: string,
): readonly WrapperOutputBinding[] {
  const bindings: WrapperOutputBinding[] = []
  for (const edge of definition.edges) {
    if (edge.boundary !== 'wrapper-output' || edge.target.nodeId !== wrapperId) continue
    if (bindings.some((binding) => binding.name === edge.target.portName)) continue
    bindings.push({
      name: edge.target.portName,
      bind: { nodeId: edge.source.nodeId, portName: edge.source.portName },
    })
  }
  return bindings
}

export function wrapperSettlement(
  rowStatus: WrapperSettlement['rowStatus'],
  outcome: NodeStepOutcome,
  errorMessage?: string,
): WrapperSettlement {
  return {
    rowStatus,
    outcome,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}
