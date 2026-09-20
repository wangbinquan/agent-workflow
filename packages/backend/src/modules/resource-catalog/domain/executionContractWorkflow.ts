import { migrateWorkflowDefinitionToLatest, type WorkflowDefinition } from '@agent-workflow/shared'
const CONTRACT_PROMPT_INPUT = 'prompt'
const CONTRACT_WORKFLOW_NODE_KINDS = new Set([
  'input',
  'output',
  'agent-single',
  'script',
  'wrapper-loop',
  'wrapper-fanout',
])

export function inspectExecutionContractWorkflowDefinition(
  storedDefinition: WorkflowDefinition,
  expectedOutputPort = 'agent-result',
): {
  readonly ok: boolean
  readonly detail: string
} {
  // RFC-354 (schema v6): a stored definition may predate v6 — normalize once,
  // so the result port is judged the way the runtime sees it (an inbound edge).
  const definition = migrateWorkflowDefinitionToLatest(storedDefinition)
  const violations: string[] = []
  if (
    !definition.inputs.some((input) => input.kind === 'text' && input.key === CONTRACT_PROMPT_INPUT)
  ) {
    violations.push(`missing text input '${CONTRACT_PROMPT_INPUT}'`)
  }
  const requiredExtraInputs = definition.inputs
    .filter((input) => input.key !== CONTRACT_PROMPT_INPUT && input.required !== false)
    .map((input) => input.key)
  if (requiredExtraInputs.length > 0) {
    violations.push(`unsupported required inputs: ${requiredExtraInputs.sort().join(', ')}`)
  }
  const forbiddenKinds = [
    ...new Set(
      definition.nodes
        .filter((node) => !CONTRACT_WORKFLOW_NODE_KINDS.has(node.kind))
        .map((node) => node.kind),
    ),
  ].sort()
  if (forbiddenKinds.length > 0)
    violations.push(`forbidden node kinds: ${forbiddenKinds.join(', ')}`)
  // RFC-354 (schema v6): an output node's ports ARE its inbound edges.
  const outputNodeIds = new Set(
    definition.nodes.filter((node) => node.kind === 'output').map((node) => node.id),
  )
  const hasResultOutput =
    definition.outputs?.some((output) => output.name === expectedOutputPort) === true ||
    definition.edges.some(
      (edge) =>
        outputNodeIds.has(edge.target.nodeId) && edge.target.portName === expectedOutputPort,
    )
  if (!hasResultOutput) violations.push(`missing output '${expectedOutputPort}'`)
  return violations.length === 0
    ? { ok: true, detail: `closed contract workflow; ${definition.nodes.length} node(s)` }
    : { ok: false, detail: violations.join('; ') }
}
