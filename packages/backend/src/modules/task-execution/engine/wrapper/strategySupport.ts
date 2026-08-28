import type { WorkflowNode } from '@agent-workflow/shared'
import type { NodeStepOutcome } from '../../domain/nodeExecution'
import type { WrapperSettlement } from '../../domain/wrapperExecution'

export interface WrapperOutputBinding {
  readonly name: string
  readonly bind: { readonly nodeId: string; readonly portName: string }
}

export function readWrapperOutputBindings(
  node: WorkflowNode,
  key: string,
): readonly WrapperOutputBinding[] {
  const value = (node as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  const bindings: WrapperOutputBinding[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string') continue
    const bind = record.bind
    if (typeof bind !== 'object' || bind === null) continue
    const target = bind as Record<string, unknown>
    if (typeof target.nodeId !== 'string' || typeof target.portName !== 'string') continue
    bindings.push({
      name: record.name,
      bind: { nodeId: target.nodeId, portName: target.portName },
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
