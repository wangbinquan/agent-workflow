import type { WorkflowDefinition, WorkflowValidationIssue } from '@agent-workflow/shared'
import { resolveWorkflowIssueTarget } from './workflow-validation-target'

export interface WorkflowValidationCounts {
  errors: number
  warnings: number
}

export interface WorkflowValidationProjection {
  nodes: Readonly<Record<string, WorkflowValidationCounts | undefined>>
  edges: Readonly<Record<string, WorkflowValidationCounts | undefined>>
}

function increment(
  target: Record<string, WorkflowValidationCounts | undefined>,
  id: string,
  issue: WorkflowValidationIssue,
): void {
  const current = target[id] ?? { errors: 0, warnings: 0 }
  target[id] =
    issue.severity === 'warning'
      ? { ...current, warnings: current.warnings + 1 }
      : { ...current, errors: current.errors + 1 }
}

/** Project only current, uniquely resolved issues onto canvas objects. */
export function projectWorkflowValidationIssues(
  definition: WorkflowDefinition,
  issues: readonly WorkflowValidationIssue[] | undefined,
): WorkflowValidationProjection {
  const nodes: Record<string, WorkflowValidationCounts | undefined> = {}
  const edges: Record<string, WorkflowValidationCounts | undefined> = {}
  for (const issue of issues ?? []) {
    const target = resolveWorkflowIssueTarget(issue, definition)
    switch (target.kind) {
      case 'node':
      case 'node-field':
      case 'node-port':
        increment(nodes, target.nodeId, issue)
        break
      case 'edge':
        increment(edges, target.edgeId, issue)
        break
      case 'workflow-input': {
        const owners = definition.nodes.filter(
          (node) =>
            node.kind === 'input' &&
            (node as unknown as { inputKey?: unknown }).inputKey === target.inputKey,
        )
        if (owners.length === 1) increment(nodes, owners[0]!.id, issue)
        break
      }
      case 'workflow-output': {
        const owners = definition.nodes.filter(
          (node) =>
            node.kind === 'output' &&
            Array.isArray((node as unknown as { ports?: unknown }).ports) &&
            ((node as unknown as { ports: Array<{ name?: unknown }> }).ports ?? []).some(
              (port) => port?.name === target.outputName,
            ),
        )
        if (owners.length === 1) increment(nodes, owners[0]!.id, issue)
        break
      }
      case 'workflow':
      case 'unknown':
        break
    }
  }
  return { nodes, edges }
}
