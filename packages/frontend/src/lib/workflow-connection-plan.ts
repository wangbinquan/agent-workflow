// RFC-199 B5 — pure connection planning shared by drag adapters and the
// guided Connection Dialog. This module returns immutable graph/node deltas;
// field mirrors and cleanup belong exclusively to applyWorkflowTransition.

import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  REVIEW_INPUT_PORT_NAME,
  declaredPorts,
  isMultiDocReviewInput,
  isRegisteredKindString,
  isReviewableBodyKind,
  kindsEqual,
  reviewApprovedPortName,
  resolveNodeAgent,
  resolveReviewInputKind,
  tryHandlerForParsedKind,
  tryParseKind,
  type PortLookupAgent,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WrapperFanoutPort,
} from '@agent-workflow/shared'
import {
  clarifyHasAttachedAgent,
  hasExistingClarifyChannel,
  isValidClarifyTarget,
} from '../components/canvas/clarifyDragHelper'
import {
  crossClarifyHasAttachedQuestioner,
  crossClarifyHasDesignerEdge,
  isStrayClarifyChannelDrop,
  isValidCrossClarifyQuestioner,
  questionerHasExistingClarifyChannel,
} from '../components/canvas/crossClarifyDragHelper'
import { markBoundaryWrapperInput, markBoundaryWrapperOutput } from './workflow-connection-boundary'

export interface WorkflowPortRef {
  nodeId: string
  portName: string
}

export interface WorkflowSemanticContext {
  agentsByName: Readonly<Record<string, PortLookupAgent | undefined>>
  inventoryRevision: string
}

/** Build the immutable capability snapshot consumed by all semantic planners. */
export function createWorkflowSemanticContext(
  agents: readonly (PortLookupAgent & { name: string; id: string })[],
  inventoryRevision?: string,
): WorkflowSemanticContext {
  const sorted = [...agents].sort((left, right) => left.name.localeCompare(right.name))
  const agentsByName: Record<string, PortLookupAgent> = {}
  for (const agent of sorted) {
    const projected: PortLookupAgent = {
      ...(agent.outputs !== undefined ? { outputs: [...agent.outputs] } : {}),
      ...(agent.outputKinds !== undefined ? { outputKinds: { ...agent.outputKinds } } : {}),
      ...(agent.outputWrapperPortNames !== undefined
        ? { outputWrapperPortNames: { ...agent.outputWrapperPortNames } }
        : {}),
      ...(agent.role !== undefined ? { role: agent.role } : {}),
    }
    // RFC-223: persisted semantic identity is ID-only. Field name stays
    // `agentsByName` temporarily to avoid a broad consumer rename.
    agentsByName[agent.id] = projected
  }
  const derivedRevision = JSON.stringify(
    sorted.map((agent) => [
      agent.name,
      agent.outputs ?? [],
      agent.outputKinds ?? {},
      agent.outputWrapperPortNames ?? {},
      agent.role ?? '',
    ]),
  )
  return {
    agentsByName,
    inventoryRevision: inventoryRevision ?? derivedRevision,
  }
}

interface GenericConnectionRequest {
  kind: 'generic'
  source: WorkflowPortRef
  targetNodeId: string
  target: { mode: 'reuse'; portName: string } | { mode: 'new'; portName: string }
  /** Drag supplies its already-minted id; guided callers may omit it. */
  edgeId?: string
  /** Preserve the pre-RFC-199 first=list<string>, later=string drag contract. */
  legacyFanoutInputInference?: boolean
}

interface ClarifyQuestionerRequest {
  kind: 'clarify-questioner'
  questionerNodeId: string
  clarifyNodeId: string
  edgeIds?: { ask: string; answer: string }
}

interface CrossQuestionerRequest {
  kind: 'cross-questioner'
  questionerNodeId: string
  crossClarifyNodeId: string
  edgeIds?: { ask: string; answer: string }
}

interface CrossDesignerRequest {
  kind: 'cross-designer'
  crossClarifyNodeId: string
  designerNodeId: string
  edgeId?: string
}

interface FanoutBoundaryInputRequest {
  kind: 'fanout-boundary-input'
  wrapperNodeId: string
  /** Existing source outside the wrapper. */
  outerEndpoint: WorkflowPortRef
  /** Existing target inside the wrapper. */
  innerEndpoint: WorkflowPortRef
  port: {
    portName: string
    kind: string
    role: 'shard' | 'broadcast'
  }
  edgeIds?: { outer: string; boundary: string }
}

interface FanoutBoundaryOutputRequest {
  kind: 'fanout-boundary-output'
  wrapperNodeId: string
  /** Existing source inside the wrapper. */
  innerEndpoint: WorkflowPortRef
  /** Existing target outside the wrapper. */
  outerEndpoint: WorkflowPortRef
  port: { portName: string; kind: string }
  edgeIds?: { boundary: string; outer: string }
}

export type ConnectionRequest =
  | GenericConnectionRequest
  | ClarifyQuestionerRequest
  | CrossQuestionerRequest
  | CrossDesignerRequest
  | FanoutBoundaryInputRequest
  | FanoutBoundaryOutputRequest

export interface SetFanoutInputsPatch {
  kind: 'set-fanout-inputs'
  wrapperNodeId: string
  inputs: ReadonlyArray<WrapperFanoutPort>
}

export type ConnectionNodePatch = SetFanoutInputsPatch

export interface ConnectionMeta {
  edgeId: string
  targetMode: 'new' | 'reuse' | 'fixed'
  syncTarget: 'generic' | 'review' | 'output' | 'fanout-boundary'
  legacyFanoutInputInference?: boolean
}

export type ConnectionCompatibility = 'compatible' | 'incompatible' | 'unknown'

export interface ConnectionAdvisory {
  code:
    | 'topology-cycle'
    | 'review-source-incompatible'
    | 'review-source-unknown'
    | 'legacy-fanout-kind-inference'
    | 'fanout-kind-incompatible'
    | 'fanout-kind-unknown'
  message: string
}

export interface ConnectionPreview {
  replacedEdgeIds: string[]
  semanticPortRenames: Array<{
    nodeId: string
    fromPortName: string
    toPortName: string
  }>
  fanoutShardDemotions: string[]
}

export interface ConnectionBlockReason {
  code:
    | 'connection-endpoint-missing'
    | 'connection-node-missing'
    | 'connection-self-loop'
    | 'connection-exact-duplicate'
    | 'connection-target-unsupported'
    | 'connection-channel-request-required'
    | 'review-fixed-input-required'
    | 'clarify-channel-invalid'
    | 'clarify-channel-occupied'
    | 'cross-clarify-channel-invalid'
    | 'cross-clarify-channel-occupied'
    | 'fanout-wrapper-invalid'
    | 'fanout-inner-endpoint-invalid'
    | 'fanout-outer-endpoint-invalid'
    | 'fanout-port-kind-invalid'
    | 'fanout-shard-kind-not-list'
    | 'fanout-shard-source-missing'
    | 'fanout-shard-state-invalid'
    | 'fanout-explicit-port-required'
    | 'edge-insert-ineligible'
    | 'edge-insert-candidate-incompatible'
  message: string
}

export type ConnectionPlan =
  | {
      ok: true
      contextRevision: string
      definitionRevision: string
      removeEdgeIds: string[]
      /** Edge insertion may atomically materialize its midpoint node. */
      addNodes?: WorkflowNode[]
      addEdges: WorkflowEdge[]
      nodePatches: ConnectionNodePatch[]
      connectionMeta: ConnectionMeta[]
      compatibility: ConnectionCompatibility
      preview: ConnectionPreview
      warnings: ConnectionAdvisory[]
    }
  | { ok: false; reason: ConnectionBlockReason }

function blocked(code: ConnectionBlockReason['code'], message: string): ConnectionPlan {
  return { ok: false, reason: { code, message } }
}

function successful(
  definition: WorkflowDefinition,
  context: WorkflowSemanticContext,
  fields: Omit<
    Extract<ConnectionPlan, { ok: true }>,
    'ok' | 'contextRevision' | 'definitionRevision'
  >,
): ConnectionPlan {
  return {
    ok: true,
    contextRevision: context.inventoryRevision,
    definitionRevision: workflowConnectionDefinitionRevision(definition),
    ...fields,
  }
}

/** Exact immutable base token used to reject Dialog plans after any draft edit. */
export function workflowConnectionDefinitionRevision(definition: WorkflowDefinition): string {
  return JSON.stringify(definition)
}

function emptyPreview(): ConnectionPreview {
  return { replacedEdgeIds: [], semanticPortRenames: [], fanoutShardDemotions: [] }
}

function allocateEdgeId(
  definition: WorkflowDefinition,
  preferred: string | undefined,
  stem = 'edge_plan',
  reserved: ReadonlySet<string> = new Set(),
): string {
  if (
    preferred !== undefined &&
    preferred !== '' &&
    !definition.edges.some((edge) => edge.id === preferred) &&
    !reserved.has(preferred)
  ) {
    return preferred
  }
  const used = new Set([...definition.edges.map((edge) => edge.id), ...reserved])
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}_${index}`
    if (!used.has(candidate)) return candidate
  }
}

function nodeById(definition: WorkflowDefinition, nodeId: string): WorkflowNode | undefined {
  return definition.nodes.find((node) => node.id === nodeId)
}

function validRef(ref: WorkflowPortRef): boolean {
  return ref.nodeId !== '' && ref.portName !== ''
}

function exactDuplicate(definition: WorkflowDefinition, edge: WorkflowEdge): boolean {
  return definition.edges.some(
    (candidate) =>
      candidate.source.nodeId === edge.source.nodeId &&
      candidate.source.portName === edge.source.portName &&
      candidate.target.nodeId === edge.target.nodeId &&
      candidate.target.portName === edge.target.portName,
  )
}

function pathExists(
  definition: WorkflowDefinition,
  fromNodeId: string,
  toNodeId: string,
  removedEdgeIds: ReadonlySet<string>,
): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of definition.edges) {
    if (removedEdgeIds.has(edge.id)) continue
    const targets = outgoing.get(edge.source.nodeId) ?? []
    targets.push(edge.target.nodeId)
    outgoing.set(edge.source.nodeId, targets)
  }
  const seen = new Set<string>()
  const pending = [fromNodeId]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === toNodeId) return true
    if (seen.has(current)) continue
    seen.add(current)
    pending.push(...(outgoing.get(current) ?? []))
  }
  return false
}

function reviewSourceCompatibility(
  definition: WorkflowDefinition,
  source: WorkflowPortRef,
  context: WorkflowSemanticContext,
): { compatibility: ConnectionCompatibility; kind?: string; warning?: ConnectionAdvisory } {
  const sourceNode = nodeById(definition, source.nodeId)
  if (sourceNode === undefined || sourceNode.kind !== 'agent-single') {
    return {
      compatibility: 'incompatible',
      warning: {
        code: 'review-source-incompatible',
        message: 'Review input must come from a declared agent output.',
      },
    }
  }
  const agentName = (sourceNode as Record<string, unknown>).agentName
  if (typeof agentName !== 'string') {
    return {
      compatibility: 'incompatible',
      warning: {
        code: 'review-source-incompatible',
        message: 'The source node does not declare an agent capability.',
      },
    }
  }
  // RFC-223 (PR-3a impl-gate H3): resolve id-first (fail closed on a stamped miss).
  const agent = resolveNodeAgent(sourceNode, context.agentsByName)
  if (agent === undefined) {
    return {
      compatibility: 'unknown',
      warning: {
        code: 'review-source-unknown',
        message: 'The source agent capability is not loaded.',
      },
    }
  }
  if (!(agent.outputs ?? []).includes(source.portName)) {
    return {
      compatibility: 'incompatible',
      warning: {
        code: 'review-source-incompatible',
        message: 'The source port is not a declared agent output.',
      },
    }
  }
  const kind = agent.outputKinds?.[source.portName]
  if (kind === undefined) {
    return {
      compatibility: 'unknown',
      warning: {
        code: 'review-source-unknown',
        message: 'The source output kind is not loaded.',
      },
    }
  }
  const parsed = tryParseKind(kind)
  const reviewable =
    parsed !== null && (isReviewableBodyKind(parsed) || isMultiDocReviewInput(kind))
  return reviewable
    ? { compatibility: 'compatible', kind }
    : {
        compatibility: 'incompatible',
        kind,
        warning: {
          code: 'review-source-incompatible',
          message: `Output kind '${kind}' is not reviewable markdown.`,
        },
      }
}

function planReviewConnection(
  definition: WorkflowDefinition,
  request: GenericConnectionRequest,
  targetNode: WorkflowNode,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  if (request.target.mode !== 'reuse' || request.target.portName !== REVIEW_INPUT_PORT_NAME) {
    return blocked(
      'review-fixed-input-required',
      `Review nodes only accept REUSE on '${REVIEW_INPUT_PORT_NAME}'.`,
    )
  }
  const edgeId = allocateEdgeId(definition, request.edgeId)
  const edge: WorkflowEdge = {
    id: edgeId,
    source: { ...request.source },
    target: { nodeId: request.targetNodeId, portName: REVIEW_INPUT_PORT_NAME },
  }
  if (exactDuplicate(definition, edge)) {
    return blocked('connection-exact-duplicate', 'That exact connection already exists.')
  }
  const removeEdgeIds = definition.edges
    .filter((candidate) => candidate.target.nodeId === targetNode.id)
    .map((candidate) => candidate.id)
  const sourcePolicy = reviewSourceCompatibility(definition, request.source, context)
  const preview = emptyPreview()
  const oldPort = reviewApprovedPortName(
    resolveReviewInputKind(targetNode, definition, context.agentsByName),
  )
  if (sourcePolicy.kind !== undefined) {
    const newPort = reviewApprovedPortName(sourcePolicy.kind)
    if (oldPort !== newPort) {
      preview.semanticPortRenames.push({
        nodeId: targetNode.id,
        fromPortName: oldPort,
        toPortName: newPort,
      })
    }
  }
  preview.replacedEdgeIds = [...removeEdgeIds]
  return successful(definition, context, {
    removeEdgeIds,
    addEdges: [edge],
    nodePatches: [],
    connectionMeta: [{ edgeId, targetMode: 'fixed', syncTarget: 'review' }],
    compatibility: sourcePolicy.compatibility,
    preview,
    warnings: sourcePolicy.warning === undefined ? [] : [sourcePolicy.warning],
  })
}

function genericCompatibility(
  definition: WorkflowDefinition,
  source: WorkflowPortRef,
  targetNode: WorkflowNode,
  targetPortName: string,
  context: WorkflowSemanticContext,
): ConnectionCompatibility {
  if (targetNode.kind === 'agent-single' || targetNode.kind === 'output') return 'compatible'
  const targetPort = declaredPorts(targetNode, definition, context.agentsByName).dataInputs.find(
    (port) => port.name === targetPortName,
  )
  if (targetPort === undefined) return 'unknown'
  const sourceNode = nodeById(definition, source.nodeId)
  if (sourceNode === undefined) return 'unknown'
  const sourcePort = declaredPorts(sourceNode, definition, context.agentsByName).dataOutputs.find(
    (port) => port.name === source.portName,
  )
  if (sourcePort?.kind === undefined || targetPort.kind === undefined) return 'unknown'
  const sourceKind = tryParseKind(sourcePort.kind)
  const targetKind = tryParseKind(targetPort.kind)
  if (sourceKind === null || targetKind === null) return 'incompatible'
  return kindsEqual(sourceKind, targetKind) ? 'compatible' : 'incompatible'
}

function combineCompatibility(
  ...values: readonly ConnectionCompatibility[]
): ConnectionCompatibility {
  if (values.includes('incompatible')) return 'incompatible'
  if (values.includes('unknown')) return 'unknown'
  return 'compatible'
}

function targetCompatibility(
  definition: WorkflowDefinition,
  source: WorkflowPortRef,
  target: WorkflowPortRef,
  context: WorkflowSemanticContext,
): ConnectionCompatibility {
  const targetNode = nodeById(definition, target.nodeId)
  if (targetNode === undefined) return 'unknown'
  if (targetNode.kind === 'review') {
    if (target.portName !== REVIEW_INPUT_PORT_NAME) return 'incompatible'
    return reviewSourceCompatibility(definition, source, context).compatibility
  }
  if (
    targetNode.kind === 'input' ||
    targetNode.kind === 'wrapper-git' ||
    targetNode.kind === 'wrapper-loop' ||
    targetNode.kind === 'clarify' ||
    targetNode.kind === 'clarify-cross-agent'
  ) {
    return 'incompatible'
  }
  return genericCompatibility(definition, source, targetNode, target.portName, context)
}

function sourceKindCompatibility(
  definition: WorkflowDefinition,
  source: WorkflowPortRef,
  expectedKind: string,
  context: WorkflowSemanticContext,
): ConnectionCompatibility {
  const sourceNode = nodeById(definition, source.nodeId)
  if (sourceNode === undefined) return 'unknown'
  if (sourceNode.kind === 'agent-single') {
    const agentName = (sourceNode as Record<string, unknown>).agentName
    if (typeof agentName !== 'string') return 'unknown'
    // RFC-223 (PR-3a impl-gate H3): resolve id-first (fail closed on a stamped miss).
    const agent = resolveNodeAgent(sourceNode, context.agentsByName)
    if (agent === undefined) return 'unknown'
    if (!(agent.outputs ?? []).includes(source.portName)) return 'incompatible'
  }
  const declared = declaredPorts(sourceNode, definition, context.agentsByName).dataOutputs.find(
    (port) => port.name === source.portName,
  )
  if (declared?.kind === undefined) return 'unknown'
  const actual = tryParseKind(declared.kind)
  const expected = tryParseKind(expectedKind)
  if (actual === null || expected === null) return 'incompatible'
  return kindsEqual(actual, expected) ? 'compatible' : 'incompatible'
}

function fanoutCompatibilityWarning(compatibility: ConnectionCompatibility): ConnectionAdvisory[] {
  if (compatibility === 'compatible') return []
  return [
    compatibility === 'unknown'
      ? {
          code: 'fanout-kind-unknown',
          message: 'The endpoint kind cannot be verified until resource inventory is loaded.',
        }
      : {
          code: 'fanout-kind-incompatible',
          message: 'The selected endpoint kind does not match the fan-out port kind.',
        },
  ]
}

function planGenericConnection(
  definition: WorkflowDefinition,
  request: GenericConnectionRequest,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  const target = { nodeId: request.targetNodeId, portName: request.target.portName }
  if (!validRef(request.source) || !validRef(target)) {
    return blocked(
      'connection-endpoint-missing',
      'Both connection endpoints and ports are required.',
    )
  }
  const sourceNode = nodeById(definition, request.source.nodeId)
  const targetNode = nodeById(definition, request.targetNodeId)
  if (sourceNode === undefined || targetNode === undefined) {
    return blocked('connection-node-missing', 'One of the selected nodes no longer exists.')
  }
  if (request.source.nodeId === request.targetNodeId) {
    return blocked('connection-self-loop', 'A node cannot connect directly to itself.')
  }
  if (
    isStrayClarifyChannelDrop({
      sourceHandle: request.source.portName,
      targetHandle: request.target.portName,
    })
  ) {
    return blocked(
      'connection-channel-request-required',
      'Clarify system ports require a typed channel request.',
    )
  }
  if (targetNode.kind === 'review') {
    return planReviewConnection(definition, request, targetNode, context)
  }
  if (
    targetNode.kind === 'input' ||
    targetNode.kind === 'wrapper-git' ||
    targetNode.kind === 'wrapper-loop' ||
    targetNode.kind === 'clarify' ||
    targetNode.kind === 'clarify-cross-agent'
  ) {
    return blocked(
      'connection-target-unsupported',
      `Node kind '${targetNode.kind}' does not accept generic inbound data.`,
    )
  }
  if (
    targetNode.kind === 'wrapper-fanout' &&
    request.target.mode === 'new' &&
    request.legacyFanoutInputInference !== true
  ) {
    return blocked(
      'fanout-explicit-port-required',
      'A new fan-out input requires explicit kind and shard/broadcast role.',
    )
  }

  const edgeId = allocateEdgeId(definition, request.edgeId)
  const rawEdge: WorkflowEdge = { id: edgeId, source: { ...request.source }, target }
  if (exactDuplicate(definition, rawEdge)) {
    return blocked('connection-exact-duplicate', 'That exact connection already exists.')
  }
  const removeEdgeIds =
    request.target.mode === 'reuse'
      ? definition.edges
          .filter(
            (candidate) =>
              candidate.target.nodeId === target.nodeId &&
              candidate.target.portName === target.portName,
          )
          .map((candidate) => candidate.id)
      : []
  const edge = markBoundaryWrapperOutput(definition, markBoundaryWrapperInput(definition, rawEdge))
  const warnings: ConnectionAdvisory[] = []
  if (pathExists(definition, target.nodeId, request.source.nodeId, new Set(removeEdgeIds))) {
    warnings.push({
      code: 'topology-cycle',
      message:
        'This connection closes a cycle; final scope-aware validation remains authoritative.',
    })
  }
  if (
    targetNode.kind === 'wrapper-fanout' &&
    request.target.mode === 'new' &&
    request.legacyFanoutInputInference === true
  ) {
    warnings.push({
      code: 'legacy-fanout-kind-inference',
      message:
        'Legacy drag inferred the fan-out input kind; guided creation requires an explicit role.',
    })
  }
  const preview = emptyPreview()
  preview.replacedEdgeIds = [...removeEdgeIds]
  return successful(definition, context, {
    removeEdgeIds,
    addEdges: [edge],
    nodePatches: [],
    connectionMeta: [
      {
        edgeId,
        targetMode: request.target.mode,
        syncTarget: targetNode.kind === 'output' ? 'output' : 'generic',
        ...(request.legacyFanoutInputInference === true
          ? { legacyFanoutInputInference: true }
          : {}),
      },
    ],
    compatibility: genericCompatibility(
      definition,
      request.source,
      targetNode,
      target.portName,
      context,
    ),
    preview,
    warnings,
  })
}

function pairedIds(
  definition: WorkflowDefinition,
  requested: { ask: string; answer: string } | undefined,
  stem: string,
): { ask: string; answer: string } {
  const ask = allocateEdgeId(definition, requested?.ask, `${stem}_ask`)
  const answer = allocateEdgeId(definition, requested?.answer, `${stem}_answer`, new Set([ask]))
  return { ask, answer }
}

function planClarifyQuestioner(
  definition: WorkflowDefinition,
  request: ClarifyQuestionerRequest,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  const clarify = nodeById(definition, request.clarifyNodeId)
  const questioner = nodeById(definition, request.questionerNodeId)
  if (clarify?.kind !== 'clarify' || !isValidClarifyTarget(questioner)) {
    return blocked(
      'clarify-channel-invalid',
      'Clarify channels require one clarify and one agent node.',
    )
  }
  if (
    hasExistingClarifyChannel(definition, request.questionerNodeId) ||
    clarifyHasAttachedAgent(definition, request.clarifyNodeId)
  ) {
    return blocked(
      'clarify-channel-occupied',
      'The clarify node or questioner already has a channel.',
    )
  }
  const ids = pairedIds(definition, request.edgeIds, 'clarify')
  const addEdges: WorkflowEdge[] = [
    {
      id: ids.ask,
      source: { nodeId: request.questionerNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: request.clarifyNodeId, portName: CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: ids.answer,
      source: { nodeId: request.clarifyNodeId, portName: CLARIFY_OUTPUT_PORT_NAME },
      target: { nodeId: request.questionerNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
  return successful(definition, context, {
    removeEdgeIds: [],
    addEdges,
    nodePatches: [],
    connectionMeta: addEdges.map((edge) => ({
      edgeId: edge.id,
      targetMode: 'fixed',
      syncTarget: 'generic',
    })),
    compatibility: 'compatible',
    preview: emptyPreview(),
    warnings: [],
  })
}

function planCrossQuestioner(
  definition: WorkflowDefinition,
  request: CrossQuestionerRequest,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  const cross = nodeById(definition, request.crossClarifyNodeId)
  const questioner = nodeById(definition, request.questionerNodeId)
  if (cross?.kind !== 'clarify-cross-agent' || !isValidCrossClarifyQuestioner(questioner)) {
    return blocked(
      'cross-clarify-channel-invalid',
      'Cross-clarify questioner channels require one cross-clarify and one agent node.',
    )
  }
  if (
    questionerHasExistingClarifyChannel(definition, request.questionerNodeId) ||
    crossClarifyHasAttachedQuestioner(definition, request.crossClarifyNodeId)
  ) {
    return blocked(
      'cross-clarify-channel-occupied',
      'The cross-clarify node or questioner already has a channel.',
    )
  }
  const ids = pairedIds(definition, request.edgeIds, 'cross_clarify')
  const addEdges: WorkflowEdge[] = [
    {
      id: ids.ask,
      source: { nodeId: request.questionerNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: request.crossClarifyNodeId, portName: CROSS_CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: ids.answer,
      source: {
        nodeId: request.crossClarifyNodeId,
        portName: CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
      },
      target: { nodeId: request.questionerNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
  return successful(definition, context, {
    removeEdgeIds: [],
    addEdges,
    nodePatches: [],
    connectionMeta: addEdges.map((edge) => ({
      edgeId: edge.id,
      targetMode: 'fixed',
      syncTarget: 'generic',
    })),
    compatibility: 'compatible',
    preview: emptyPreview(),
    warnings: [],
  })
}

function planCrossDesigner(
  definition: WorkflowDefinition,
  request: CrossDesignerRequest,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  const cross = nodeById(definition, request.crossClarifyNodeId)
  const designer = nodeById(definition, request.designerNodeId)
  if (cross?.kind !== 'clarify-cross-agent' || designer?.kind !== 'agent-single') {
    return blocked(
      'cross-clarify-channel-invalid',
      'Cross-clarify designer feedback requires one cross-clarify and one agent node.',
    )
  }
  if (crossClarifyHasDesignerEdge(definition, request.crossClarifyNodeId)) {
    return blocked(
      'cross-clarify-channel-occupied',
      'The cross-clarify node already has a designer.',
    )
  }
  const edgeId = allocateEdgeId(definition, request.edgeId, 'cross_clarify_designer')
  const edge: WorkflowEdge = {
    id: edgeId,
    source: {
      nodeId: request.crossClarifyNodeId,
      portName: CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
    },
    target: {
      nodeId: request.designerNodeId,
      portName: CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
    },
  }
  return successful(definition, context, {
    removeEdgeIds: [],
    addEdges: [edge],
    nodePatches: [],
    connectionMeta: [{ edgeId, targetMode: 'fixed', syncTarget: 'generic' }],
    compatibility: 'compatible',
    preview: emptyPreview(),
    warnings: [],
  })
}

function readFanoutInputs(node: WorkflowNode): WrapperFanoutPort[] {
  const raw = (node as Record<string, unknown>).inputs
  if (!Array.isArray(raw)) return []
  const inputs: WrapperFanoutPort[] = []
  for (const candidate of raw) {
    const port = candidate as { name?: unknown; kind?: unknown; isShardSource?: unknown }
    if (typeof port.name !== 'string' || typeof port.kind !== 'string') continue
    inputs.push({
      name: port.name,
      kind: port.kind,
      ...(port.isShardSource === true ? { isShardSource: true } : {}),
    })
  }
  return inputs
}

function validateFanoutEndpoints(
  definition: WorkflowDefinition,
  wrapperNodeId: string,
  innerNodeId: string,
  outerNodeId: string,
): { wrapper: WorkflowNode; memberIds: string[] } | ConnectionPlan {
  const wrapper = nodeById(definition, wrapperNodeId)
  if (wrapper?.kind !== 'wrapper-fanout') {
    return blocked('fanout-wrapper-invalid', 'The selected wrapper is not a fan-out wrapper.')
  }
  const rawNodeIds = (wrapper as Record<string, unknown>).nodeIds
  const memberIds = Array.isArray(rawNodeIds)
    ? rawNodeIds.filter((id): id is string => typeof id === 'string')
    : []
  if (!memberIds.includes(innerNodeId) || nodeById(definition, innerNodeId) === undefined) {
    return blocked('fanout-inner-endpoint-invalid', 'The inner endpoint is not a wrapper member.')
  }
  if (memberIds.includes(outerNodeId) || nodeById(definition, outerNodeId) === undefined) {
    return blocked(
      'fanout-outer-endpoint-invalid',
      'The outer endpoint must exist outside the wrapper.',
    )
  }
  return { wrapper, memberIds }
}

function planFanoutBoundaryInput(
  definition: WorkflowDefinition,
  request: FanoutBoundaryInputRequest,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  if (
    !validRef(request.outerEndpoint) ||
    !validRef(request.innerEndpoint) ||
    request.port.portName === ''
  ) {
    return blocked('connection-endpoint-missing', 'All fan-out endpoints and ports are required.')
  }
  const checked = validateFanoutEndpoints(
    definition,
    request.wrapperNodeId,
    request.innerEndpoint.nodeId,
    request.outerEndpoint.nodeId,
  )
  if ('ok' in checked) return checked
  const parsedKind = tryParseKind(request.port.kind)
  if (parsedKind === null || !isRegisteredKindString(request.port.kind)) {
    return blocked('fanout-port-kind-invalid', `Fan-out kind '${request.port.kind}' is malformed.`)
  }
  if (request.port.role === 'shard' && parsedKind.kind !== 'list') {
    return blocked('fanout-shard-kind-not-list', 'A fan-out shard source must have kind list<T>.')
  }

  const existing = readFanoutInputs(checked.wrapper)
  const selectedExists = existing.some((port) => port.name === request.port.portName)
  let inputs = existing.map((port) => ({ ...port }))
  const demotions: string[] = []
  if (request.port.role === 'shard') {
    inputs = inputs.map((port) => {
      if (port.name === request.port.portName) {
        return { name: port.name, kind: request.port.kind, isShardSource: true }
      }
      if (port.isShardSource === true) demotions.push(port.name)
      return { name: port.name, kind: port.kind }
    })
    if (!selectedExists) {
      inputs.push({ name: request.port.portName, kind: request.port.kind, isShardSource: true })
    }
  } else {
    if (!selectedExists) inputs.push({ name: request.port.portName, kind: request.port.kind })
    else {
      inputs = inputs.map((port) =>
        port.name === request.port.portName ? { name: port.name, kind: request.port.kind } : port,
      )
    }
    const shardCount = inputs.filter((port) => port.isShardSource === true).length
    if (shardCount === 0) {
      return blocked(
        'fanout-shard-source-missing',
        'Choose one list<T> input as the shard source before adding broadcasts.',
      )
    }
    if (shardCount !== 1) {
      return blocked(
        'fanout-shard-state-invalid',
        'The wrapper has multiple shard sources; choose one shard to heal it first.',
      )
    }
  }

  const reserved = new Set<string>()
  const outerId = allocateEdgeId(definition, request.edgeIds?.outer, 'fanout_outer', reserved)
  reserved.add(outerId)
  const boundaryId = allocateEdgeId(
    definition,
    request.edgeIds?.boundary,
    'fanout_boundary',
    reserved,
  )
  const addEdges: WorkflowEdge[] = [
    {
      id: outerId,
      source: { ...request.outerEndpoint },
      target: { nodeId: request.wrapperNodeId, portName: request.port.portName },
    },
    {
      id: boundaryId,
      source: { nodeId: request.wrapperNodeId, portName: request.port.portName },
      target: { ...request.innerEndpoint },
      boundary: 'wrapper-input',
    },
  ]
  const removeEdgeIds = definition.edges
    .filter(
      (edge) =>
        (edge.target.nodeId === request.wrapperNodeId &&
          edge.target.portName === request.port.portName) ||
        (edge.boundary === 'wrapper-input' &&
          edge.target.nodeId === request.innerEndpoint.nodeId &&
          edge.target.portName === request.innerEndpoint.portName),
    )
    .map((edge) => edge.id)
  const preview = emptyPreview()
  preview.replacedEdgeIds = [...removeEdgeIds]
  preview.fanoutShardDemotions = demotions
  const compatibility = sourceKindCompatibility(
    definition,
    request.outerEndpoint,
    request.port.kind,
    context,
  )
  return successful(definition, context, {
    removeEdgeIds,
    addEdges,
    nodePatches: [{ kind: 'set-fanout-inputs', wrapperNodeId: request.wrapperNodeId, inputs }],
    connectionMeta: addEdges.map((edge) => ({
      edgeId: edge.id,
      targetMode: 'fixed',
      syncTarget: 'fanout-boundary',
    })),
    compatibility,
    preview,
    warnings: fanoutCompatibilityWarning(compatibility),
  })
}

function planFanoutBoundaryOutput(
  definition: WorkflowDefinition,
  request: FanoutBoundaryOutputRequest,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  if (
    !validRef(request.innerEndpoint) ||
    !validRef(request.outerEndpoint) ||
    request.port.portName === ''
  ) {
    return blocked('connection-endpoint-missing', 'All fan-out endpoints and ports are required.')
  }
  const checked = validateFanoutEndpoints(
    definition,
    request.wrapperNodeId,
    request.innerEndpoint.nodeId,
    request.outerEndpoint.nodeId,
  )
  if ('ok' in checked) return checked
  if (!isRegisteredKindString(request.port.kind)) {
    return blocked('fanout-port-kind-invalid', `Fan-out kind '${request.port.kind}' is malformed.`)
  }
  const reserved = new Set<string>()
  const boundaryId = allocateEdgeId(
    definition,
    request.edgeIds?.boundary,
    'fanout_boundary',
    reserved,
  )
  reserved.add(boundaryId)
  const outerId = allocateEdgeId(definition, request.edgeIds?.outer, 'fanout_outer', reserved)
  const addEdges: WorkflowEdge[] = [
    {
      id: boundaryId,
      source: { ...request.innerEndpoint },
      target: { nodeId: request.wrapperNodeId, portName: request.port.portName },
      boundary: 'wrapper-output',
    },
    {
      id: outerId,
      source: { nodeId: request.wrapperNodeId, portName: request.port.portName },
      target: { ...request.outerEndpoint },
    },
  ]
  const removeEdgeIds = definition.edges
    .filter(
      (edge) =>
        (edge.boundary === 'wrapper-output' &&
          edge.target.nodeId === request.wrapperNodeId &&
          edge.target.portName === request.port.portName) ||
        (edge.target.nodeId === request.outerEndpoint.nodeId &&
          edge.target.portName === request.outerEndpoint.portName),
    )
    .map((edge) => edge.id)
  const preview = emptyPreview()
  preview.replacedEdgeIds = [...removeEdgeIds]
  const innerNode = nodeById(definition, request.innerEndpoint.nodeId)
  let innerCompatibility: ConnectionCompatibility = 'unknown'
  if (innerNode?.kind !== 'agent-single') {
    innerCompatibility = 'incompatible'
  } else {
    // RFC-223 (PR-3a impl-gate H3): resolve id-first (fail closed on a stamped miss).
    const agent = resolveNodeAgent(innerNode, context.agentsByName)
    if (agent !== undefined) {
      const promoted = declaredPorts(
        checked.wrapper,
        definition,
        context.agentsByName,
      ).dataOutputs.find((port) => port.name === request.port.portName)
      const expectedWrapperPort =
        agent.outputWrapperPortNames?.[request.innerEndpoint.portName] ??
        request.innerEndpoint.portName
      if (
        agent.role !== 'aggregator' ||
        agent.outputs === undefined ||
        !agent.outputs.includes(request.innerEndpoint.portName) ||
        expectedWrapperPort !== request.port.portName ||
        promoted?.kind === undefined
      ) {
        innerCompatibility = 'incompatible'
      } else {
        const requestedKind = tryParseKind(request.port.kind)
        const promotedKind = tryParseKind(promoted.kind)
        innerCompatibility =
          requestedKind !== null && promotedKind !== null && kindsEqual(requestedKind, promotedKind)
            ? 'compatible'
            : 'incompatible'
      }
    }
  }
  const compatibility = combineCompatibility(
    innerCompatibility,
    targetCompatibility(
      definition,
      { nodeId: request.wrapperNodeId, portName: request.port.portName },
      request.outerEndpoint,
      context,
    ),
  )
  return successful(definition, context, {
    removeEdgeIds,
    addEdges,
    nodePatches: [],
    connectionMeta: addEdges.map((edge) => ({
      edgeId: edge.id,
      targetMode: 'fixed',
      syncTarget: 'fanout-boundary',
    })),
    compatibility,
    preview,
    warnings: fanoutCompatibilityWarning(compatibility),
  })
}

function edgeInsertionParents(definition: WorkflowDefinition): Map<string, string> {
  const parents = new Map<string, string>()
  for (const node of definition.nodes) {
    if (
      node.kind !== 'wrapper-git' &&
      node.kind !== 'wrapper-loop' &&
      node.kind !== 'wrapper-fanout'
    ) {
      continue
    }
    const nodeIds = (node as Record<string, unknown>).nodeIds
    if (!Array.isArray(nodeIds)) continue
    for (const childId of nodeIds) {
      if (typeof childId === 'string') parents.set(childId, node.id)
    }
  }
  return parents
}

export function isWorkflowEdgeInsertable(
  definition: WorkflowDefinition,
  edgeId: string,
  context: WorkflowSemanticContext,
): boolean {
  const edge = definition.edges.find((candidate) => candidate.id === edgeId)
  if (edge === undefined) return false
  if (edge.boundary !== undefined) return false
  const sourceNode = nodeById(definition, edge.source.nodeId)
  const targetNode = nodeById(definition, edge.target.nodeId)
  if (sourceNode === undefined || targetNode === undefined) return false
  const parents = edgeInsertionParents(definition)
  if (parents.has(sourceNode.id) || parents.has(targetNode.id)) return false

  const sourcePorts = declaredPorts(sourceNode, definition, context.agentsByName)
  const targetPorts = declaredPorts(targetNode, definition, context.agentsByName)
  if (sourcePorts.systemOutputs.some((port) => port.name === edge.source.portName)) return false
  if (targetPorts.systemInputs.some((port) => port.name === edge.target.portName)) return false
  const sourceKind = sourcePorts.dataOutputs.find(
    (port) => port.name === edge.source.portName,
  )?.kind
  if (sourceKind === undefined) return true
  const parsed = tryParseKind(sourceKind)
  if (parsed === null) return true
  const handler = tryHandlerForParsedKind(parsed)
  return handler === null || handler.carriesData(parsed)
}

/**
 * Build the one connection plan used by the edge-midpoint picker. The old
 * target endpoint is never renamed: A.out → B.existing becomes
 * A.out → N.out-name and N.compatible-output → B.existing.
 */
export function planWorkflowEdgeInsertion(
  definition: WorkflowDefinition,
  edgeId: string,
  node: WorkflowNode,
  context: WorkflowSemanticContext,
): ConnectionPlan {
  const oldEdge = definition.edges.find((edge) => edge.id === edgeId)
  if (
    oldEdge === undefined ||
    definition.nodes.some((candidate) => candidate.id === node.id) ||
    !isWorkflowEdgeInsertable(definition, oldEdge.id, context)
  ) {
    return blocked(
      'edge-insert-ineligible',
      'Only an ordinary top-level data edge can accept an inserted step.',
    )
  }

  const base: WorkflowDefinition = {
    ...definition,
    nodes: [...definition.nodes, node],
    edges: definition.edges.filter((edge) => edge.id !== oldEdge.id),
  }
  const inboundTarget =
    node.kind === 'review'
      ? ({ mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME } as const)
      : ({ mode: 'new', portName: oldEdge.source.portName } as const)
  const inbound = planWorkflowConnection(
    base,
    {
      kind: 'generic',
      source: { ...oldEdge.source },
      targetNodeId: node.id,
      target: inboundTarget,
    },
    context,
  )
  if (!inbound.ok || inbound.compatibility !== 'compatible' || inbound.removeEdgeIds.length > 0) {
    return blocked(
      'edge-insert-candidate-incompatible',
      'The selected step cannot accept data from this edge.',
    )
  }

  const intermediate: WorkflowDefinition = {
    ...base,
    edges: [...base.edges, ...inbound.addEdges],
  }
  const outputPorts = declaredPorts(node, intermediate, context.agentsByName).dataOutputs
  let outbound: Extract<ConnectionPlan, { ok: true }> | null = null
  for (const output of outputPorts) {
    const target =
      nodeById(definition, oldEdge.target.nodeId)?.kind === 'review'
        ? ({ mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME } as const)
        : ({ mode: 'reuse', portName: oldEdge.target.portName } as const)
    const candidate = planWorkflowConnection(
      intermediate,
      {
        kind: 'generic',
        source: { nodeId: node.id, portName: output.name },
        targetNodeId: oldEdge.target.nodeId,
        target,
      },
      context,
    )
    if (
      candidate.ok &&
      candidate.compatibility === 'compatible' &&
      candidate.removeEdgeIds.length === 0
    ) {
      outbound = candidate
      break
    }
  }
  if (outbound === null) {
    return blocked(
      'edge-insert-candidate-incompatible',
      'The selected step has no compatible output for the existing target input.',
    )
  }

  return {
    ok: true,
    contextRevision: context.inventoryRevision,
    definitionRevision: workflowConnectionDefinitionRevision(definition),
    removeEdgeIds: [oldEdge.id],
    addNodes: [node],
    addEdges: [...inbound.addEdges, ...outbound.addEdges],
    nodePatches: [...inbound.nodePatches, ...outbound.nodePatches],
    connectionMeta: [...inbound.connectionMeta, ...outbound.connectionMeta],
    compatibility: 'compatible',
    preview: {
      replacedEdgeIds: [oldEdge.id],
      semanticPortRenames: [
        ...inbound.preview.semanticPortRenames,
        ...outbound.preview.semanticPortRenames,
      ],
      fanoutShardDemotions: [
        ...inbound.preview.fanoutShardDemotions,
        ...outbound.preview.fanoutShardDemotions,
      ],
    },
    warnings: [...inbound.warnings, ...outbound.warnings],
  }
}

export function planWorkflowConnection(
  definition: WorkflowDefinition,
  request: ConnectionRequest,
  semanticContext: WorkflowSemanticContext,
): ConnectionPlan {
  switch (request.kind) {
    case 'generic':
      return planGenericConnection(definition, request, semanticContext)
    case 'clarify-questioner':
      return planClarifyQuestioner(definition, request, semanticContext)
    case 'cross-questioner':
      return planCrossQuestioner(definition, request, semanticContext)
    case 'cross-designer':
      return planCrossDesigner(definition, request, semanticContext)
    case 'fanout-boundary-input':
      return planFanoutBoundaryInput(definition, request, semanticContext)
    case 'fanout-boundary-output':
      return planFanoutBoundaryOutput(definition, request, semanticContext)
  }
}
