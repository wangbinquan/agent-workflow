// RFC-199 B5 — the single semantic write reconciler. Every caller supplies a
// typed transition; disconnect cascades, mirrors, node patches, workflow input
// declarations, semantic review renames, and disappeared derived ports run in
// one deterministic transaction.

import {
  REVIEW_INPUT_PORT_NAME,
  collectNodeReferenceClosure,
  declaredPorts,
  isWrapperKind,
  pruneDeletedNodeReferences,
  pruneWorkflowPortReferences,
  reviewApprovedPortName,
  rewriteWorkflowPortReferences,
  resolveReviewInputKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeReferenceWarning,
  type WorkflowPortRename,
  type WorkflowPortReference,
} from '@agent-workflow/shared'
import { cascadeRemoveClarifyChannel } from '../components/canvas/clarifyDragHelper'
import { cascadeRemoveCrossClarifyChannel } from '../components/canvas/crossClarifyDragHelper'
import {
  applyConnectionForReviewOutput,
  applyDisconnectForReviewOutput,
} from '../components/canvas/connectionSync'
import { syncInputDefs } from '../components/canvas/syncInputDefs'
import { ensureLegacyWrapperFanoutInputForEdge } from './workflow-connection-boundary'
import type {
  ConnectionNodePatch,
  ConnectionPlan,
  WorkflowSemanticContext,
} from './workflow-connection-plan'
import { workflowConnectionDefinitionRevision } from './workflow-connection-plan'

type SuccessfulConnectionPlan = Extract<ConnectionPlan, { ok: true }>

export type WorkflowTransition =
  | { kind: 'connection'; plan: SuccessfulConnectionPlan }
  | { kind: 'replace-definition'; next: WorkflowDefinition }
  | { kind: 'rename-edge-target-port'; edgeId: string; portName: string }
  | {
      kind: 'set-review-input-source'
      reviewNodeId: string
      inputSource: { nodeId: string; portName: string }
    }
  | {
      kind: 'set-output-ports'
      outputNodeId: string
      ports: ReadonlyArray<{
        name: string
        bind: { nodeId: string; portName: string }
      }>
    }
  | {
      kind: 'delete-selection'
      nodeIds: readonly string[]
      edgeIds: readonly string[]
    }

export type WorkflowTransitionWarning =
  | WorkflowNodeReferenceWarning
  | {
      code: 'connection-plan-context-stale' | 'connection-plan-graph-stale'
      message: string
    }
  | {
      code:
        | 'edge-target-port-rename-blocked'
        | 'edge-target-port-conflict'
        | 'edge-transition-subject-missing'
      message: string
    }

export interface WorkflowTransitionResult {
  next: WorkflowDefinition
  warnings: WorkflowTransitionWarning[]
}

/** Fixed/system/boundary targets cannot be renamed from EdgeInspector. */
export function isEdgeTargetPortRenameable(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
  context: WorkflowSemanticContext,
): boolean {
  const targetNode = definition.nodes.find((node) => node.id === edge.target.nodeId)
  if (targetNode === undefined || edge.boundary !== undefined) return false
  const systemInput = declaredPorts(targetNode, definition, context.agentsByName).systemInputs.some(
    (port) => port.name === edge.target.portName,
  )
  if (systemInput) return false
  return (
    targetNode.kind === 'agent-single' ||
    targetNode.kind === 'output' ||
    targetNode.kind === 'wrapper-fanout'
  )
}

function applyConnectionNodePatches(
  definition: WorkflowDefinition,
  patches: readonly ConnectionNodePatch[],
): WorkflowDefinition {
  if (patches.length === 0) return definition
  const byWrapperId = new Map(patches.map((patch) => [patch.wrapperNodeId, patch] as const))
  let changed = false
  const nodes = definition.nodes.map((node) => {
    const patch = byWrapperId.get(node.id)
    if (patch === undefined || node.kind !== 'wrapper-fanout') return node
    changed = true
    return {
      ...(node as Record<string, unknown>),
      inputs: patch.inputs.map((port) => ({ ...port })),
    } as unknown as WorkflowNode
  })
  return changed ? { ...definition, nodes } : definition
}

function applyInputDeclarationSync(definition: WorkflowDefinition): WorkflowDefinition {
  const inputs = syncInputDefs(definition.inputs ?? [], definition.nodes)
  return inputs === (definition.inputs ?? []) ? definition : { ...definition, inputs }
}

function reviewPortRenames(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
  context: WorkflowSemanticContext,
): WorkflowPortRename[] {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]))
  const renames: WorkflowPortRename[] = []
  for (const node of after.nodes) {
    if (node.kind !== 'review') continue
    const previous = beforeById.get(node.id)
    if (previous?.kind !== 'review') continue
    const fromPortName = reviewApprovedPortName(
      resolveReviewInputKind(previous, before, context.agentsByName),
    )
    const toPortName = reviewApprovedPortName(
      resolveReviewInputKind(node, after, context.agentsByName),
    )
    if (fromPortName !== toPortName) {
      renames.push({ nodeId: node.id, fromPortName, toPortName })
    }
  }
  return renames
}

function disappearedOutputPorts(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
  context: WorkflowSemanticContext,
  semanticRenames: readonly WorkflowPortRename[],
): WorkflowPortReference[] {
  const afterById = new Map(after.nodes.map((node) => [node.id, node]))
  const renamed = new Set(
    semanticRenames.map((rename) => `${rename.nodeId}\u0000${rename.fromPortName}`),
  )
  const removed: WorkflowPortReference[] = []
  for (const previous of before.nodes) {
    const current = afterById.get(previous.id)
    if (current === undefined) continue
    const oldPorts = declaredPorts(previous, before, context.agentsByName).dataOutputs
    const newNames = new Set(
      declaredPorts(current, after, context.agentsByName).dataOutputs.map((port) => port.name),
    )
    for (const port of oldPorts) {
      if (newNames.has(port.name)) continue
      if (renamed.has(`${previous.id}\u0000${port.name}`)) continue
      removed.push({ nodeId: previous.id, portName: port.name })
    }
  }
  return removed
}

function reconcileDerivedPorts(
  previous: WorkflowDefinition,
  candidate: WorkflowDefinition,
  context: WorkflowSemanticContext,
): WorkflowTransitionResult {
  let semanticBefore = previous
  let working = candidate
  const warnings: WorkflowTransitionWarning[] = []
  // A port prune can clear a review inputSource, which in turn changes that
  // review's derived output. Iterate through that second-order change; the
  // number of reviews bounds the meaningful chain length.
  const maxPasses = working.nodes.filter((node) => node.kind === 'review').length + 2
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const renames = reviewPortRenames(semanticBefore, working, context)
    if (renames.length > 0) {
      const rewritten = rewriteWorkflowPortReferences(working, renames)
      warnings.push(...rewritten.warnings)
      if (!rewritten.safe) return { next: previous, warnings }
      working = rewritten.definition
    }

    const disappeared = disappearedOutputPorts(semanticBefore, working, context, renames)
    if (disappeared.length === 0) return { next: working, warnings }
    const beforePrune = working
    const pruned = pruneWorkflowPortReferences(working, disappeared)
    warnings.push(...pruned.warnings)
    if (!pruned.safe) return { next: previous, warnings }
    working = pruned.definition
    semanticBefore = beforePrune
  }
  return { next: working, warnings }
}

function deletedEdges(previous: WorkflowDefinition, candidate: WorkflowDefinition): WorkflowEdge[] {
  const surviving = new Set(candidate.edges.map((edge) => edge.id))
  return previous.edges.filter((edge) => !surviving.has(edge.id))
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [],
  )
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

/**
 * Membership changes invalidate persisted auto-fit dimensions. Manual
 * sizeLocked wrappers deliberately retain their user-owned dimensions.
 * Comparing as sets avoids treating a harmless nodeIds reorder as a resize.
 */
function reconcileWrapperMembershipSizes(
  previous: WorkflowDefinition,
  candidate: WorkflowDefinition,
): WorkflowDefinition {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]))
  let changed = false
  const nodes = candidate.nodes.map((node) => {
    if (!isWrapperKind(node.kind)) return node
    const prior = previousById.get(node.id)
    if (prior === undefined || !isWrapperKind(prior.kind)) return node
    const priorRecord = prior as Record<string, unknown>
    const currentRecord = node as Record<string, unknown>
    if (
      sameStringSet(stringSet(priorRecord.nodeIds), stringSet(currentRecord.nodeIds)) ||
      currentRecord.size === undefined
    ) {
      return node
    }
    const size = currentRecord.size as { sizeLocked?: unknown } | undefined
    if (size?.sizeLocked === true) return node
    const next = { ...currentRecord }
    delete next.size
    changed = true
    return next as unknown as WorkflowNode
  })
  return changed ? { ...candidate, nodes } : candidate
}

function reconcileRemovalAndReferences(
  previous: WorkflowDefinition,
  candidate: WorkflowDefinition,
): WorkflowTransitionResult {
  const warnings: WorkflowTransitionWarning[] = []
  const survivorIds = new Set(candidate.nodes.map((node) => node.id))
  let staged = candidate
  if (previous.nodes.some((node) => !survivorIds.has(node.id))) {
    const pruned = pruneDeletedNodeReferences(staged, survivorIds)
    warnings.push(...pruned.warnings)
    if (!pruned.safe) return { next: previous, warnings }
    staged = pruned.definition
  }
  staged = reconcileWrapperMembershipSizes(previous, staged)

  const removed = deletedEdges(previous, staged)
  if (removed.length > 0) {
    staged = applyDisconnectForReviewOutput(staged, removed)
    staged = cascadeRemoveClarifyChannel(staged, removed)
    staged = cascadeRemoveCrossClarifyChannel(staged, removed)
  }
  return { next: staged, warnings }
}

function applyConnectionTransition(
  previous: WorkflowDefinition,
  plan: SuccessfulConnectionPlan,
  context: WorkflowSemanticContext,
): WorkflowTransitionResult {
  if (plan.contextRevision !== context.inventoryRevision) {
    return {
      next: previous,
      warnings: [
        {
          code: 'connection-plan-context-stale',
          message: 'Resource inventory changed after this connection was planned.',
        },
      ],
    }
  }
  if (plan.definitionRevision !== workflowConnectionDefinitionRevision(previous)) {
    return {
      next: previous,
      warnings: [
        {
          code: 'connection-plan-graph-stale',
          message: 'The draft changed after this connection was planned.',
        },
      ],
    }
  }
  const addedIds = new Set(plan.addEdges.map((edge) => edge.id))
  const addNodes = plan.addNodes ?? []
  const addedNodeIds = new Set(addNodes.map((node) => node.id))
  if (
    addedIds.size !== plan.addEdges.length ||
    previous.edges.some((edge) => addedIds.has(edge.id) && !plan.removeEdgeIds.includes(edge.id)) ||
    addedNodeIds.size !== addNodes.length ||
    previous.nodes.some((node) => addedNodeIds.has(node.id))
  ) {
    return {
      next: previous,
      warnings: [
        {
          code: 'connection-plan-graph-stale',
          message: 'The graph changed after this connection was planned.',
        },
      ],
    }
  }

  const removeIds = new Set(plan.removeEdgeIds)
  let staged: WorkflowDefinition = {
    ...previous,
    edges: previous.edges.filter((edge) => !removeIds.has(edge.id)),
  }
  const removal = reconcileRemovalAndReferences(previous, staged)
  if (
    removal.next === previous &&
    removal.warnings.some((warning) => 'action' in warning && warning.action === 'abort')
  ) {
    return removal
  }
  staged =
    addNodes.length === 0
      ? removal.next
      : {
          ...removal.next,
          nodes: [...removal.next.nodes, ...addNodes.map((node) => ({ ...node }))],
        }
  staged = applyConnectionNodePatches(staged, plan.nodePatches)
  staged = { ...staged, edges: [...staged.edges, ...plan.addEdges.map((edge) => ({ ...edge }))] }

  const metaByEdgeId = new Map(plan.connectionMeta.map((meta) => [meta.edgeId, meta]))
  for (const plannedEdge of plan.addEdges) {
    const meta = metaByEdgeId.get(plannedEdge.id)
    const currentEdge = staged.edges.find((edge) => edge.id === plannedEdge.id)
    if (meta === undefined || currentEdge === undefined) continue
    if (meta.syncTarget === 'review' || meta.syncTarget === 'output') {
      staged = applyConnectionForReviewOutput(staged, currentEdge, {
        viaCatchAll: meta.targetMode === 'new',
      })
    }
    if (meta.legacyFanoutInputInference === true) {
      const reconciledEdge = staged.edges.find((edge) => edge.id === plannedEdge.id) ?? currentEdge
      staged = ensureLegacyWrapperFanoutInputForEdge(staged, reconciledEdge)
    }
  }
  staged = applyInputDeclarationSync(staged)
  const derived = reconcileDerivedPorts(previous, staged, context)
  return { next: derived.next, warnings: [...removal.warnings, ...derived.warnings] }
}

function nextTransitionEdgeId(definition: WorkflowDefinition): string {
  const ids = new Set(definition.edges.map((edge) => edge.id))
  for (let index = 1; ; index += 1) {
    const candidate = `edge_transition_${index}`
    if (!ids.has(candidate)) return candidate
  }
}

function completePortRef(ref: { nodeId: string; portName: string }): boolean {
  return ref.nodeId !== '' && ref.portName !== ''
}

function finishSemanticTransition(
  previous: WorkflowDefinition,
  staged: WorkflowDefinition,
  context: WorkflowSemanticContext,
  warnings: WorkflowTransitionWarning[],
): WorkflowTransitionResult {
  const synced = applyInputDeclarationSync(staged)
  const derived = reconcileDerivedPorts(previous, synced, context)
  return { next: derived.next, warnings: [...warnings, ...derived.warnings] }
}

function applyReviewInputSourceTransition(
  previous: WorkflowDefinition,
  reviewNodeId: string,
  inputSource: { nodeId: string; portName: string },
  context: WorkflowSemanticContext,
): WorkflowTransitionResult {
  const review = previous.nodes.find((node) => node.id === reviewNodeId)
  if (review?.kind !== 'review') {
    return {
      next: previous,
      warnings: [
        { code: 'edge-transition-subject-missing', message: 'The review node no longer exists.' },
      ],
    }
  }
  const existing = previous.edges.filter((edge) => edge.target.nodeId === reviewNodeId)
  const alreadyCanonical =
    completePortRef(inputSource) &&
    existing.length === 1 &&
    existing[0]?.target.portName === REVIEW_INPUT_PORT_NAME &&
    existing[0]?.source.nodeId === inputSource.nodeId &&
    existing[0]?.source.portName === inputSource.portName
  const currentSource = (review as Record<string, unknown>).inputSource as
    | { nodeId?: unknown; portName?: unknown }
    | undefined
  if (
    alreadyCanonical &&
    currentSource?.nodeId === inputSource.nodeId &&
    currentSource.portName === inputSource.portName
  ) {
    return { next: previous, warnings: [] }
  }

  const removedIds = new Set(existing.map((edge) => edge.id))
  const removal = reconcileRemovalAndReferences(previous, {
    ...previous,
    edges: previous.edges.filter((edge) => !removedIds.has(edge.id)),
  })
  let staged: WorkflowDefinition = {
    ...removal.next,
    nodes: removal.next.nodes.map((node) =>
      node.id === reviewNodeId
        ? ({
            ...(node as Record<string, unknown>),
            inputSource: { ...inputSource },
          } as unknown as WorkflowNode)
        : node,
    ),
  }
  if (completePortRef(inputSource)) {
    const edge: WorkflowEdge = {
      id: nextTransitionEdgeId(staged),
      source: { ...inputSource },
      target: { nodeId: reviewNodeId, portName: REVIEW_INPUT_PORT_NAME },
    }
    staged = { ...staged, edges: [...staged.edges, edge] }
    staged = applyConnectionForReviewOutput(staged, edge)
  }
  return finishSemanticTransition(previous, staged, context, removal.warnings)
}

function applyOutputPortsTransition(
  previous: WorkflowDefinition,
  outputNodeId: string,
  ports: ReadonlyArray<{
    name: string
    bind: { nodeId: string; portName: string }
  }>,
  context: WorkflowSemanticContext,
): WorkflowTransitionResult {
  const output = previous.nodes.find((node) => node.id === outputNodeId)
  if (output?.kind !== 'output') {
    return {
      next: previous,
      warnings: [
        { code: 'edge-transition-subject-missing', message: 'The output node no longer exists.' },
      ],
    }
  }
  const previousPortsRaw = (output as Record<string, unknown>).ports
  const previousPorts = Array.isArray(previousPortsRaw)
    ? (previousPortsRaw as Array<{
        name?: unknown
        bind?: { nodeId?: unknown; portName?: unknown }
      }>)
    : []
  const managedNames = new Set<string>()
  for (const port of previousPorts) if (typeof port.name === 'string') managedNames.add(port.name)
  for (const port of ports) managedNames.add(port.name)
  const nextByName = new Map(ports.map((port) => [port.name, port] as const))
  const keptEdges: WorkflowEdge[] = []
  const edgesToAdd: WorkflowEdge[] = []
  const canonicalExisting = new Set<string>()
  for (const edge of previous.edges) {
    if (edge.target.nodeId !== outputNodeId || !managedNames.has(edge.target.portName)) {
      keptEdges.push(edge)
      continue
    }
    const nextPort = nextByName.get(edge.target.portName)
    const matches =
      nextPort !== undefined &&
      completePortRef(nextPort.bind) &&
      edge.source.nodeId === nextPort.bind.nodeId &&
      edge.source.portName === nextPort.bind.portName &&
      !canonicalExisting.has(edge.target.portName)
    if (matches) {
      keptEdges.push(edge)
      canonicalExisting.add(edge.target.portName)
    }
  }
  let idBasis: WorkflowDefinition = { ...previous, edges: keptEdges }
  for (const port of ports) {
    if (!completePortRef(port.bind) || canonicalExisting.has(port.name) || port.name === '')
      continue
    const edge: WorkflowEdge = {
      id: nextTransitionEdgeId(idBasis),
      source: { ...port.bind },
      target: { nodeId: outputNodeId, portName: port.name },
    }
    edgesToAdd.push(edge)
    idBasis = { ...idBasis, edges: [...idBasis.edges, edge] }
  }
  const removal = reconcileRemovalAndReferences(previous, { ...previous, edges: keptEdges })
  let staged: WorkflowDefinition = {
    ...removal.next,
    nodes: removal.next.nodes.map((node) =>
      node.id === outputNodeId
        ? ({
            ...(node as Record<string, unknown>),
            ports: ports.map((port) => ({ name: port.name, bind: { ...port.bind } })),
          } as unknown as WorkflowNode)
        : node,
    ),
    edges: [...removal.next.edges, ...edgesToAdd],
  }
  for (const edge of edgesToAdd) {
    staged = applyConnectionForReviewOutput(staged, edge)
  }
  return finishSemanticTransition(previous, staged, context, removal.warnings)
}

function buildDeletionCandidate(
  previous: WorkflowDefinition,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): WorkflowTransitionResult {
  const closure = collectNodeReferenceClosure(previous, nodeIds)
  const removedNodes = new Set(closure.nodeIds)
  const removedEdges = new Set(edgeIds)
  const nodes = previous.nodes.filter((node) => !removedNodes.has(node.id))
  const candidate: WorkflowDefinition = {
    ...previous,
    nodes,
    edges: previous.edges.filter((edge) => !removedEdges.has(edge.id)),
  }
  return {
    next: candidate,
    warnings: closure.warnings,
  }
}

function renameTargetPortCandidate(
  previous: WorkflowDefinition,
  edgeId: string,
  portName: string,
  context: WorkflowSemanticContext,
): WorkflowTransitionResult {
  const edge = previous.edges.find((candidate) => candidate.id === edgeId)
  if (edge === undefined) {
    return {
      next: previous,
      warnings: [
        { code: 'edge-transition-subject-missing', message: 'The selected edge no longer exists.' },
      ],
    }
  }
  const targetNode = previous.nodes.find((node) => node.id === edge.target.nodeId)
  if (targetNode === undefined) {
    return {
      next: previous,
      warnings: [
        { code: 'edge-transition-subject-missing', message: 'The target node no longer exists.' },
      ],
    }
  }
  if (portName === '' || portName === edge.target.portName) return { next: previous, warnings: [] }
  const exactConflict = previous.edges.some(
    (candidate) =>
      candidate.id !== edge.id &&
      candidate.source.nodeId === edge.source.nodeId &&
      candidate.source.portName === edge.source.portName &&
      candidate.target.nodeId === edge.target.nodeId &&
      candidate.target.portName === portName,
  )
  if (exactConflict) {
    return {
      next: previous,
      warnings: [
        { code: 'edge-target-port-conflict', message: 'That exact connection already exists.' },
      ],
    }
  }
  if (!isEdgeTargetPortRenameable(previous, edge, context)) {
    return {
      next: previous,
      warnings: [
        {
          code: 'edge-target-port-rename-blocked',
          message: 'This fixed, system, or boundary port cannot be renamed directly.',
        },
      ],
    }
  }

  let nodes = previous.nodes
  let edges = previous.edges
  if (targetNode.kind === 'agent-single') {
    edges = previous.edges.map((candidate) =>
      candidate.id === edge.id
        ? { ...candidate, target: { ...candidate.target, portName } }
        : candidate,
    )
  } else if (targetNode.kind === 'output') {
    const record = targetNode as Record<string, unknown>
    const ports = Array.isArray(record.ports)
      ? (record.ports as Array<Record<string, unknown>>)
      : []
    if (
      !ports.some((port) => port.name === edge.target.portName) ||
      ports.some((port) => port.name === portName)
    ) {
      return {
        next: previous,
        warnings: [
          {
            code: 'edge-target-port-conflict',
            message: 'The output declaration is missing or already uses that port name.',
          },
        ],
      }
    }
    nodes = previous.nodes.map((node) =>
      node.id === targetNode.id
        ? ({
            ...(node as Record<string, unknown>),
            ports: ports.map((port) =>
              port.name === edge.target.portName ? { ...port, name: portName } : { ...port },
            ),
          } as unknown as WorkflowNode)
        : node,
    )
    edges = previous.edges.map((candidate) =>
      candidate.target.nodeId === targetNode.id &&
      candidate.target.portName === edge.target.portName
        ? { ...candidate, target: { ...candidate.target, portName } }
        : candidate,
    )
  } else if (targetNode.kind === 'wrapper-fanout') {
    const record = targetNode as Record<string, unknown>
    const inputs = Array.isArray(record.inputs)
      ? (record.inputs as Array<Record<string, unknown>>)
      : []
    if (
      !inputs.some((input) => input.name === edge.target.portName) ||
      inputs.some((input) => input.name === portName)
    ) {
      return {
        next: previous,
        warnings: [
          {
            code: 'edge-target-port-conflict',
            message: 'The fan-out declaration is missing or already uses that port name.',
          },
        ],
      }
    }
    nodes = previous.nodes.map((node) =>
      node.id === targetNode.id
        ? ({
            ...(node as Record<string, unknown>),
            inputs: inputs.map((input) =>
              input.name === edge.target.portName ? { ...input, name: portName } : { ...input },
            ),
          } as unknown as WorkflowNode)
        : node,
    )
    edges = previous.edges.map((candidate) => {
      if (
        candidate.target.nodeId === targetNode.id &&
        candidate.target.portName === edge.target.portName
      ) {
        return { ...candidate, target: { ...candidate.target, portName } }
      }
      if (
        candidate.boundary === 'wrapper-input' &&
        candidate.source.nodeId === targetNode.id &&
        candidate.source.portName === edge.target.portName
      ) {
        return { ...candidate, source: { ...candidate.source, portName } }
      }
      return candidate
    })
  }
  return { next: { ...previous, nodes, edges }, warnings: [] }
}

export function applyWorkflowTransition(
  previous: WorkflowDefinition,
  transition: WorkflowTransition,
  semanticContext: WorkflowSemanticContext,
): WorkflowTransitionResult {
  if (transition.kind === 'connection') {
    return applyConnectionTransition(previous, transition.plan, semanticContext)
  }
  if (transition.kind === 'set-review-input-source') {
    return applyReviewInputSourceTransition(
      previous,
      transition.reviewNodeId,
      transition.inputSource,
      semanticContext,
    )
  }
  if (transition.kind === 'set-output-ports') {
    return applyOutputPortsTransition(
      previous,
      transition.outputNodeId,
      transition.ports,
      semanticContext,
    )
  }
  if (transition.kind === 'rename-edge-target-port') {
    const renamed = renameTargetPortCandidate(
      previous,
      transition.edgeId,
      transition.portName,
      semanticContext,
    )
    if (renamed.next === previous) return renamed
    const derived = reconcileDerivedPorts(previous, renamed.next, semanticContext)
    return { next: derived.next, warnings: [...renamed.warnings, ...derived.warnings] }
  }

  let initial: WorkflowTransitionResult
  if (transition.kind === 'delete-selection') {
    initial = buildDeletionCandidate(previous, transition.nodeIds, transition.edgeIds)
  } else {
    initial = { next: transition.next, warnings: [] }
  }
  if (
    initial.next === previous &&
    initial.warnings.some((warning) => 'action' in warning && warning.action === 'abort')
  ) {
    return initial
  }
  const removal = reconcileRemovalAndReferences(previous, initial.next)
  const synced = applyInputDeclarationSync(removal.next)
  const derived = reconcileDerivedPorts(previous, synced, semanticContext)
  return {
    next: derived.next,
    warnings: [...initial.warnings, ...removal.warnings, ...derived.warnings],
  }
}
