// RFC-302 — normalize Intent-created workflows before the immutable draft is
// hashed and persisted. This domain seam is pure: no DB, ACL, actor, manifest,
// filesystem, or frontend dependencies.

import {
  NODE_KIND,
  WORKFLOW_SCHEMA_VERSION,
  analyzeWorkflowScopeTree,
  effectiveWorkflowNodePosition,
  isWrapperKind,
  planWorkflowLayout,
  type IntentChangeset,
  type IntentOp,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowLayoutWarning,
  type WorkflowNode,
} from '@agent-workflow/shared'

export const INTENT_WORKFLOW_LAYOUT_ORIGIN = Object.freeze({ x: 80, y: 80 })

export interface IntentWorkflowCreateLayoutWarning {
  opId: string
  warning: WorkflowLayoutWarning
}

export interface IntentWorkflowCreateLayoutResult {
  changeset: IntentChangeset
  errors: string[]
  warnings: IntentWorkflowCreateLayoutWarning[]
}

type GuardResult<T> = { ok: true; value: T } | { ok: false; reason: string }

const NODE_KINDS = new Set<string>(NODE_KIND)
const EDGE_BOUNDARIES = new Set(['wrapper-input', 'wrapper-output'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finitePoint(value: unknown): value is { x: number; y: number } {
  if (!isRecord(value)) return false
  return Number.isFinite(value.x) && Number.isFinite(value.y)
}

function finiteSize(
  value: unknown,
): value is { width: number; height: number; sizeLocked?: boolean } {
  if (!isRecord(value)) return false
  return (
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    (value.width as number) > 0 &&
    (value.height as number) > 0 &&
    (value.sizeLocked === undefined || typeof value.sizeLocked === 'boolean')
  )
}

function guardFailure(reason: string): GuardResult<never> {
  return { ok: false, reason }
}

/**
 * Build the smallest formal workflow projection the layout kernel needs. The
 * Intent wire remains authoritative and untouched: handle/tempRef identities
 * are only copied into private placeholder id fields for this call.
 */
function projectLayoutInput(value: unknown): GuardResult<WorkflowDefinition> {
  if (!isRecord(value)) return guardFailure('definition is not an object')
  if (!Array.isArray(value.nodes)) return guardFailure('definition.nodes is not an array')
  if (!Array.isArray(value.edges)) return guardFailure('definition.edges is not an array')

  const projectedNodes: WorkflowNode[] = []
  const nodeIds = new Set<string>()
  for (const raw of value.nodes) {
    if (!isRecord(raw)) return guardFailure('workflow node is not an object')
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      return guardFailure('workflow node id is missing')
    }
    if (nodeIds.has(raw.id)) return guardFailure(`duplicate node id ${raw.id}`)
    nodeIds.add(raw.id)
    if (typeof raw.kind !== 'string' || !NODE_KINDS.has(raw.kind)) {
      return guardFailure(`node ${raw.id} has an unknown kind`)
    }
    const kind = raw.kind as NodeKind
    if (raw.position !== undefined && !finitePoint(raw.position)) {
      return guardFailure(`node ${raw.id} has non-finite position`)
    }
    if (raw.size !== undefined && !finiteSize(raw.size)) {
      return guardFailure(`node ${raw.id} has invalid size`)
    }

    const projected: Record<string, unknown> = { id: raw.id, kind }
    if (raw.position !== undefined) projected.position = { ...raw.position }
    if (raw.size !== undefined) projected.size = { ...raw.size }
    if (isWrapperKind(kind)) {
      if (raw.nodeIds !== undefined) {
        if (!Array.isArray(raw.nodeIds) || raw.nodeIds.some((id) => typeof id !== 'string')) {
          return guardFailure(`wrapper ${raw.id} has invalid nodeIds`)
        }
        projected.nodeIds = [...raw.nodeIds]
      } else {
        projected.nodeIds = []
      }
    }

    // Private placeholders let port helpers see canonical-looking identity
    // without resolving or persisting an Intent handle/tempRef.
    if (kind === 'agent-single' && typeof raw.agentRef === 'string') {
      projected.agentId = raw.agentRef
    }
    if (kind === 'call-workflow' && typeof raw.workflowRef === 'string') {
      projected.workflowId = raw.workflowRef
    }
    if (kind === 'call-workgroup' && typeof raw.workgroupRef === 'string') {
      projected.workgroupId = raw.workgroupRef
    }
    projectedNodes.push(projected as unknown as WorkflowNode)
  }

  const projectedEdges: WorkflowEdge[] = []
  const edgeIds = new Set<string>()
  for (const raw of value.edges) {
    if (!isRecord(raw)) return guardFailure('workflow edge is not an object')
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      return guardFailure('workflow edge id is missing')
    }
    if (edgeIds.has(raw.id)) return guardFailure(`duplicate edge id ${raw.id}`)
    edgeIds.add(raw.id)
    if (!isRecord(raw.source) || !isRecord(raw.target)) {
      return guardFailure(`edge ${raw.id} has invalid endpoints`)
    }
    const sourceNodeId = raw.source.nodeId
    const sourcePortName = raw.source.portName
    const targetNodeId = raw.target.nodeId
    const targetPortName = raw.target.portName
    if (
      typeof sourceNodeId !== 'string' ||
      sourceNodeId.length === 0 ||
      typeof sourcePortName !== 'string' ||
      sourcePortName.length === 0 ||
      typeof targetNodeId !== 'string' ||
      targetNodeId.length === 0 ||
      typeof targetPortName !== 'string' ||
      targetPortName.length === 0
    ) {
      return guardFailure(`edge ${raw.id} has invalid endpoints`)
    }
    if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) {
      return guardFailure(`edge ${raw.id} references a missing node`)
    }
    if (raw.boundary !== undefined && !EDGE_BOUNDARIES.has(String(raw.boundary))) {
      return guardFailure(`edge ${raw.id} has invalid boundary`)
    }
    projectedEdges.push({
      id: raw.id,
      source: { nodeId: sourceNodeId, portName: sourcePortName },
      target: { nodeId: targetNodeId, portName: targetPortName },
      ...(raw.boundary === undefined
        ? {}
        : { boundary: raw.boundary as 'wrapper-input' | 'wrapper-output' }),
    })
  }

  const projected: WorkflowDefinition = {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: projectedNodes,
    edges: projectedEdges,
  }
  const scope = analyzeWorkflowScopeTree(projected)
  if (scope.issues.length > 0) {
    const issue = scope.issues[0]!
    return guardFailure(`invalid wrapper membership: ${issue.code}`)
  }
  return { ok: true, value: projected }
}

function inputError(opId: string, reason: string): string {
  return `${opId}: workflow definition cannot be auto-laid out (${reason}) (intent-workflow-layout-input-invalid)`
}

function overflowError(opId: string, wrapperId: string): string {
  return `${opId}: size-locked wrapper ${wrapperId} cannot contain its laid-out children (intent-workflow-layout-size-locked-overflow)`
}

function geometryFromPlan(
  original: Record<string, unknown>,
  planned: WorkflowDefinition,
): GuardResult<Record<string, unknown>> {
  const plannedById = new Map(
    planned.nodes.map((node, index) => [node.id, { node, index }] as const),
  )
  const rawNodes = original.nodes
  if (!Array.isArray(rawNodes)) return guardFailure('definition.nodes is not an array')
  const nodes: Record<string, unknown>[] = []
  for (const raw of rawNodes) {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      return guardFailure('workflow node changed during layout')
    }
    const plannedState = plannedById.get(raw.id)
    if (plannedState === undefined) {
      return guardFailure(`node ${raw.id} has no finite planned position`)
    }
    const plannedNode = plannedState.node
    const plannedPosition = effectiveWorkflowNodePosition(plannedNode, plannedState.index)
    if (!finitePoint(plannedPosition)) {
      return guardFailure(`node ${raw.id} has no finite planned position`)
    }
    const next: Record<string, unknown> = {
      ...raw,
      position: { x: plannedPosition.x, y: plannedPosition.y },
    }
    if (isWrapperKind(plannedNode.kind)) {
      const plannedSize = (plannedNode as Record<string, unknown>).size
      if (plannedSize !== undefined) {
        if (!finiteSize(plannedSize)) {
          return guardFailure(`wrapper ${raw.id} has no finite planned size`)
        }
        next.size = {
          ...(isRecord(raw.size) ? raw.size : {}),
          width: plannedSize.width,
          height: plannedSize.height,
        }
      }
    }
    nodes.push(next)
  }
  return { ok: true, value: { ...original, nodes } }
}

function normalizeWorkflowCreateOp(
  op: Extract<IntentOp, { action: 'create'; resourceType: 'workflow' }>,
): {
  op: IntentOp
  errors: string[]
  warnings: IntentWorkflowCreateLayoutWarning[]
} {
  try {
    const definition = structuredClone(op.payload.definition) as unknown
    const projection = projectLayoutInput(definition)
    if (!projection.ok) {
      return { op, errors: [inputError(op.opId, projection.reason)], warnings: [] }
    }
    const plan = planWorkflowLayout(projection.value, {
      selection: { mode: 'all' },
      rootAnchor: INTENT_WORKFLOW_LAYOUT_ORIGIN,
    })
    const invariantWarning = plan.warnings.find(
      (warning) => warning.code === 'cross-scope-selection',
    )
    if (invariantWarning !== undefined) {
      return { op, errors: [inputError(op.opId, 'layout invariant failed')], warnings: [] }
    }
    if (!isRecord(definition)) {
      return { op, errors: [inputError(op.opId, 'definition is not an object')], warnings: [] }
    }
    const projected = geometryFromPlan(definition, plan.next)
    if (!projected.ok) {
      return { op, errors: [inputError(op.opId, projected.reason)], warnings: [] }
    }

    const warnings = plan.warnings.map((warning) => ({ opId: op.opId, warning }))
    const errors = plan.warnings.flatMap((warning) =>
      warning.code === 'size-locked-overflow' && warning.wrapperNodeId !== undefined
        ? [overflowError(op.opId, warning.wrapperNodeId)]
        : [],
    )
    return {
      op: {
        ...op,
        payload: { ...op.payload, definition: projected.value as typeof op.payload.definition },
      },
      errors,
      warnings,
    }
  } catch {
    // Payloads and thrown planner details are intentionally not surfaced or
    // logged here. The stable code is enough for review/retry diagnostics.
    return { op, errors: [inputError(op.opId, 'planner failed')], warnings: [] }
  }
}

/** Layout only model-created workflows; updates and every other op are exact no-ops. */
export function normalizeIntentWorkflowCreateLayouts(
  changeset: IntentChangeset,
): IntentWorkflowCreateLayoutResult {
  const errors: string[] = []
  const warnings: IntentWorkflowCreateLayoutWarning[] = []
  let changed = false
  const ops = changeset.ops.map((op) => {
    if (op.action !== 'create' || op.resourceType !== 'workflow') return op
    const normalized = normalizeWorkflowCreateOp(op)
    errors.push(...normalized.errors)
    warnings.push(...normalized.warnings)
    if (normalized.op !== op) changed = true
    return normalized.op
  })
  return {
    changeset: changed ? { ...changeset, ops } : changeset,
    errors,
    warnings,
  }
}
