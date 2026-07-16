import type {
  WorkflowDefinition,
  WorkflowNodeFieldKey,
  WorkflowValidationIssue,
  WorkflowValidationTarget,
} from '@agent-workflow/shared'

export type ResolvedWorkflowIssueTarget = WorkflowValidationTarget | { kind: 'unknown' }

const WORKFLOW_CODES = new Set([
  'topology-cycle',
  'input-key-duplicate',
  'clarify-multiple-clarify-on-same-agent',
])

const WORKFLOW_INPUT_CODES = new Set([
  'upload-input-target-dir-missing',
  'upload-input-target-dir-invalid',
  'input-orphan-declared',
])

const EDGE_POINTER_CODES = new Set([
  'edge-source-node-missing',
  'edge-target-node-missing',
  'fanout-inner-chain-unsupported',
  'boundary-input-source-not-wrapper',
  'boundary-input-target-not-inner',
  'boundary-output-target-not-wrapper',
  'boundary-output-source-not-inner',
  'boundary-output-source-must-be-aggregator',
])

const NODE_POINTER_CODES = new Set([
  'wrapper-empty',
  'wrapper-fanout-nested',
  'wrapper-loop-nested',
  'wrapper-loop-inner-data-cycle',
  'wrapper-children-outside-bounds',
  'review-rerunnable-out-of-scope',
  'clarify-input-source-missing',
  'clarify-target-not-agent',
  'clarify-self-loop',
  'clarify-no-iteration-cap',
  'cross-clarify-target-not-agent-single',
  'cross-clarify-has-downstream',
  'cross-clarify-multiple-designers',
  'cross-clarify-no-iteration-cap',
  'cross-clarify-target-not-ancestor',
  'cross-clarify-self-review-warning',
  'system-port-illegal-target',
  'system-port-illegal-source',
  'system-port-mispaired-target',
  'multiple-aggregators-in-fanout',
])

const NODE_FIELD_CODES: Readonly<Record<string, WorkflowNodeFieldKey>> = {
  'wrapper-loop-max-iterations': 'loop-max-iterations',
  'wrapper-loop-exit-condition': 'loop-exit-condition',
  'wrapper-loop-exit-node-missing': 'loop-exit-condition',
  'wrapper-loop-exit-port-missing': 'loop-exit-condition',
  'wrapper-fanout-shard-source-missing': 'fanout-inputs',
  'wrapper-fanout-shard-source-duplicate': 'fanout-inputs',
  'wrapper-fanout-shard-source-must-be-list': 'fanout-inputs',
  'agent-not-found': 'agent',
  'aggregator-agent-outside-fanout': 'agent',
  'skill-not-found': 'agent',
  'plugin-not-found': 'agent',
  'plugin-disabled': 'agent',
  'agent-dependency-not-found': 'agent',
  'input-key-not-declared': 'input-definition',
  'review-input-source-missing': 'review-source',
  'review-input-list-item-not-markdown': 'review-source',
  'review-input-source-not-markdown': 'review-source',
  'prompt-template-deprecated-token': 'prompt',
  'prompt-template-unresolved': 'prompt',
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

function outputNames(definition: WorkflowDefinition): string[] {
  const names: string[] = []
  for (const node of definition.nodes ?? []) {
    if (node.kind !== 'output') continue
    const ports = (node as Record<string, unknown>).ports
    if (!Array.isArray(ports)) continue
    for (const port of ports) {
      if (port === null || typeof port !== 'object') continue
      const name = (port as Record<string, unknown>).name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

function validateStrictTarget(
  target: WorkflowValidationTarget,
  definition: WorkflowDefinition,
): ResolvedWorkflowIssueTarget {
  const nodeCounts = counts((definition.nodes ?? []).map((node) => node.id))
  const edgeCounts = counts((definition.edges ?? []).map((edge) => edge.id))
  const inputCounts = counts((definition.inputs ?? []).map((input) => input.key))
  const outputCounts = counts(outputNames(definition))

  switch (target.kind) {
    case 'node':
    case 'node-field':
    case 'node-port':
      return nodeCounts.get(target.nodeId) === 1 ? target : { kind: 'unknown' }
    case 'edge':
      return edgeCounts.get(target.edgeId) === 1 ? target : { kind: 'unknown' }
    case 'workflow-input': {
      const count = inputCounts.get(target.inputKey) ?? 0
      if (count === 0) return { kind: 'unknown' }
      return count === 1 ? target : { kind: 'workflow' }
    }
    case 'workflow-output': {
      const count = outputCounts.get(target.outputName) ?? 0
      if (count === 0) return { kind: 'unknown' }
      return count === 1 ? target : { kind: 'workflow' }
    }
    case 'workflow':
      return target
  }
}

function uniqueById<T extends { id: string }>(items: T[], id: string): T | undefined {
  const matches = items.filter((item) => item.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * RFC-199 §7.1 compatibility resolver. Strict targets are authoritative. A
 * stale strict target never falls through to its legacy pointer, while old
 * pointer/code pairs are promoted only when their semantic identity is unique.
 */
export function resolveWorkflowIssueTarget(
  issue: WorkflowValidationIssue,
  definition: WorkflowDefinition,
): ResolvedWorkflowIssueTarget {
  if (issue.target !== undefined) return validateStrictTarget(issue.target, definition)

  const pointer = issue.pointer
  if (WORKFLOW_CODES.has(issue.code)) return { kind: 'workflow' }
  if (pointer === undefined || pointer.length === 0) return { kind: 'unknown' }

  const nodes = definition.nodes ?? []
  const edges = definition.edges ?? []
  const inputs = definition.inputs ?? []
  const node = uniqueById(nodes, pointer)
  const edge = uniqueById(edges, pointer)

  if (WORKFLOW_INPUT_CODES.has(issue.code)) {
    const matches = inputs.filter((input) => input.key === pointer)
    if (matches.length === 0) return { kind: 'unknown' }
    return matches.length === 1
      ? { kind: 'workflow-input', inputKey: pointer }
      : { kind: 'workflow' }
  }

  if (issue.code === 'edge-source-port-missing' && edge !== undefined) {
    return validateStrictTarget(
      {
        kind: 'node-port',
        nodeId: edge.source.nodeId,
        direction: 'output',
        portName: edge.source.portName,
      },
      definition,
    )
  }
  if (issue.code === 'edge-target-port-missing' && edge !== undefined) {
    return validateStrictTarget(
      {
        kind: 'node-port',
        nodeId: edge.target.nodeId,
        direction: 'input',
        portName: edge.target.portName,
      },
      definition,
    )
  }
  if (issue.code === 'boundary-input-port-not-declared' && edge !== undefined) {
    return validateStrictTarget(
      {
        kind: 'node-port',
        nodeId: edge.source.nodeId,
        direction: 'input',
        portName: edge.source.portName,
      },
      definition,
    )
  }
  if (EDGE_POINTER_CODES.has(issue.code)) {
    return edge === undefined ? { kind: 'unknown' } : { kind: 'edge', edgeId: edge.id }
  }

  if (node !== undefined) {
    const field = NODE_FIELD_CODES[issue.code]
    if (field !== undefined) return { kind: 'node-field', nodeId: node.id, field }
    if (issue.code === 'binding-node-missing' || issue.code === 'binding-port-missing') {
      return node.kind === 'wrapper-loop'
        ? { kind: 'node-field', nodeId: node.id, field: 'loop-output-bindings' }
        : { kind: 'node', nodeId: node.id }
    }
    if (
      issue.code === 'clarify-questions-port-missing' ||
      issue.code === 'clarify-multiple-source-agents' ||
      issue.code === 'cross-clarify-input-source-missing' ||
      issue.code === 'cross-clarify-multiple-questioners'
    ) {
      return { kind: 'node-port', nodeId: node.id, direction: 'input', portName: 'questions' }
    }
    if (issue.code === 'clarify-answers-port-disconnected') {
      return { kind: 'node-port', nodeId: node.id, direction: 'output', portName: 'answers' }
    }
    if (issue.code === 'cross-clarify-manual-edge-missing') {
      return { kind: 'node-port', nodeId: node.id, direction: 'output', portName: 'to_designer' }
    }
    if (issue.code === 'cross-clarify-auto-edge-deleted') {
      return { kind: 'node-port', nodeId: node.id, direction: 'output', portName: 'to_questioner' }
    }
    if (NODE_POINTER_CODES.has(issue.code)) return { kind: 'node', nodeId: node.id }
  }

  // Final identity-only compatibility for old, uncategorised issue codes.
  const matchingInputs = inputs.filter((input) => input.key === pointer)
  if (matchingInputs.length > 1) return { kind: 'workflow' }
  const identityTargets: WorkflowValidationTarget[] = []
  if (node !== undefined) identityTargets.push({ kind: 'node', nodeId: node.id })
  if (edge !== undefined) identityTargets.push({ kind: 'edge', edgeId: edge.id })
  if (matchingInputs.length === 1) {
    identityTargets.push({ kind: 'workflow-input', inputKey: pointer })
  }
  if (identityTargets.length === 1) return identityTargets[0]!
  return { kind: 'unknown' }
}
