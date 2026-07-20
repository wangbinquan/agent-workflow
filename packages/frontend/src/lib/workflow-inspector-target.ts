import type {
  WorkflowDefinition,
  WorkflowNodeFieldKey,
  WorkflowValidationTarget,
} from '@agent-workflow/shared'
import type { CanvasSelection } from '@/components/canvas/nodes/types'

function domToken(value: string): string {
  return encodeURIComponent(value)
}

export function workflowInspectorHeadingId(nodeId: string): string {
  return `workflow-inspector-node-${domToken(nodeId)}`
}

export function workflowInspectorFieldId(nodeId: string, field: WorkflowNodeFieldKey): string {
  return `workflow-inspector-field-${domToken(nodeId)}-${field}`
}

export function workflowInspectorPortId(
  nodeId: string,
  direction: 'input' | 'output',
  portName: string,
): string {
  return `workflow-inspector-port-${domToken(nodeId)}-${direction}-${domToken(portName)}`
}

export const WORKFLOW_EDGE_INSPECTOR_HEADING_ID = 'workflow-edge-inspector-heading'

export interface WorkflowIssueNavigationPlan {
  selection: CanvasSelection | null
  focusId: string | null
}

function unique<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined
}

/**
 * Turn one already-resolved semantic target into the editor selection + stable
 * inspector anchor that can repair it. Compound workflow input/output targets
 * are promoted to a node only when exactly one canvas object owns that row;
 * duplicates deliberately stay at workflow scope rather than guessing.
 */
export function planWorkflowIssueNavigation(
  target: WorkflowValidationTarget,
  definition: WorkflowDefinition,
): WorkflowIssueNavigationPlan {
  switch (target.kind) {
    case 'node':
      return {
        selection: { kind: 'node', id: target.nodeId },
        focusId: workflowInspectorHeadingId(target.nodeId),
      }
    case 'node-field':
      return {
        selection: { kind: 'node', id: target.nodeId },
        focusId: workflowInspectorFieldId(target.nodeId, target.field),
      }
    case 'node-port':
      return {
        selection: { kind: 'node', id: target.nodeId },
        focusId: workflowInspectorPortId(target.nodeId, target.direction, target.portName),
      }
    case 'edge':
      return {
        selection: { kind: 'edge', id: target.edgeId },
        focusId: WORKFLOW_EDGE_INSPECTOR_HEADING_ID,
      }
    case 'workflow-input': {
      const owner = unique(
        definition.nodes.filter(
          (node) =>
            node.kind === 'input' &&
            (node as unknown as { inputKey?: unknown }).inputKey === target.inputKey,
        ),
      )
      return owner === undefined
        ? { selection: null, focusId: null }
        : {
            selection: { kind: 'node', id: owner.id },
            focusId: workflowInspectorFieldId(owner.id, 'input-definition'),
          }
    }
    case 'workflow-output': {
      const owners = definition.nodes.filter((node) => {
        if (node.kind !== 'output') return false
        const ports = (node as unknown as { ports?: unknown }).ports
        return (
          Array.isArray(ports) &&
          ports.some(
            (port) =>
              port !== null &&
              typeof port === 'object' &&
              (port as { name?: unknown }).name === target.outputName,
          )
        )
      })
      const owner = unique(owners)
      return owner === undefined
        ? { selection: null, focusId: null }
        : {
            selection: { kind: 'node', id: owner.id },
            focusId: workflowInspectorPortId(owner.id, 'input', target.outputName),
          }
    }
    case 'workflow':
      return { selection: null, focusId: null }
  }
}

const FOCUSABLE_INSPECTOR_CONTROL =
  'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role="combobox"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])'

/** Focus the first repair control inside an anchor, falling back to the anchor. */
export function focusWorkflowInspectorAnchor(
  focusId: string,
  root: Document | HTMLElement = document,
): boolean {
  const candidate =
    root instanceof Document
      ? root.getElementById(focusId)
      : root.ownerDocument.getElementById(focusId)
  const anchor =
    root instanceof Document || (candidate !== null && root.contains(candidate)) ? candidate : null
  if (!(anchor instanceof HTMLElement)) return false
  const control = anchor.matches(FOCUSABLE_INSPECTOR_CONTROL)
    ? anchor
    : anchor.querySelector<HTMLElement>(FOCUSABLE_INSPECTOR_CONTROL)
  ;(control ?? anchor).focus()
  return document.activeElement === (control ?? anchor)
}
