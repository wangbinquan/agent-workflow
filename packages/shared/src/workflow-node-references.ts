// RFC-199 T7.1 — single source of truth for node-id / PortRef fields stored in
// WorkflowDefinition. Clipboard rewrite, deletion prune, and port rename must
// all walk this inventory so a reference cannot be repaired in one path while
// remaining stale in another.

import {
  isWrapperKind,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from './schemas/workflow'

export interface WorkflowNodeReferenceDescriptor {
  /** String-array node references; copy/delete filters entries outside the target set. */
  nodeIdLists: readonly string[]
  /** A field whose whole value is a PortRef, e.g. review.inputSource. */
  directPortRefs: readonly string[]
  /** A field containing nodeId/portName plus semantic keys, e.g. loop.exitCondition. */
  embeddedPortRefs: readonly string[]
  /** Arrays of `{ ..., bind: PortRef }`, e.g. output.ports / loop.outputBindings. */
  bindingLists: readonly string[]
}

const NO_NODE_REFERENCES = {
  nodeIdLists: [],
  directPortRefs: [],
  embeddedPortRefs: [],
  bindingLists: [],
} as const satisfies WorkflowNodeReferenceDescriptor

/**
 * Adding a NodeKind without declaring its reference shape is a type error.
 * Existing kinds are additionally guarded at runtime by the unmanaged-field
 * ratchet below because WorkflowNodeSchema intentionally uses passthrough().
 */
export const WORKFLOW_NODE_REFERENCE_INVENTORY = {
  'agent-single': NO_NODE_REFERENCES,
  input: NO_NODE_REFERENCES,
  output: {
    nodeIdLists: [],
    directPortRefs: [],
    embeddedPortRefs: [],
    bindingLists: ['ports'],
  },
  'wrapper-git': {
    nodeIdLists: ['nodeIds'],
    directPortRefs: [],
    embeddedPortRefs: [],
    bindingLists: [],
  },
  'wrapper-loop': {
    nodeIdLists: ['nodeIds'],
    directPortRefs: [],
    embeddedPortRefs: ['exitCondition'],
    bindingLists: ['outputBindings'],
  },
  'wrapper-fanout': {
    nodeIdLists: ['nodeIds'],
    directPortRefs: [],
    embeddedPortRefs: [],
    bindingLists: [],
  },
  review: {
    nodeIdLists: ['rerunnableOnReject', 'rerunnableOnIterate'],
    directPortRefs: ['inputSource'],
    embeddedPortRefs: [],
    bindingLists: [],
  },
  clarify: NO_NODE_REFERENCES,
  'clarify-cross-agent': NO_NODE_REFERENCES,
} as const satisfies Record<NodeKind, WorkflowNodeReferenceDescriptor>

export type WorkflowNodeReferenceWarningCode =
  | 'wrapper-child-missing'
  | 'wrapper-membership-cycle'
  | 'copy-reference-outside-slice'
  | 'copy-node-id-unmapped'
  | 'deleted-node-reference-pruned'
  | 'disappeared-port-reference-pruned'
  | 'node-reference-inventory-malformed'
  | 'node-reference-inventory-unmanaged'

export interface WorkflowNodeReferenceWarning {
  code: WorkflowNodeReferenceWarningCode
  /** Node carrying the field; absent for a top-level output. */
  nodeId?: string
  /** Edge being dropped because an endpoint is outside the target set. */
  edgeId?: string
  /** Stable field path, with list indices rendered as `[n]`. */
  field: string
  referencedNodeId?: string
  /** Present when a warning identifies one node-scoped port. */
  referencedPortName?: string
  action: 'clear' | 'filter' | 'drop' | 'abort'
  message: string
  /** Present for wrapper membership cycles. */
  cycle?: string[]
}

export interface WorkflowNodeClosureResult {
  /** Definition declaration order, regardless of root/child traversal order. */
  nodeIds: string[]
  warnings: WorkflowNodeReferenceWarning[]
}

export interface WorkflowNodeReferenceTransformResult<T> {
  /** `false` means a passthrough field looked reference-like but is not inventoried. */
  safe: boolean
  warnings: WorkflowNodeReferenceWarning[]
  value: T
}

export interface RewrittenWorkflowNodeResult {
  node: WorkflowNode
  warnings: WorkflowNodeReferenceWarning[]
  safe: boolean
}

export interface WorkflowNodeSlice {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface RewrittenWorkflowNodeSlice extends WorkflowNodeSlice {
  warnings: WorkflowNodeReferenceWarning[]
  safe: boolean
}

export interface WorkflowDefinitionReferenceResult {
  definition: WorkflowDefinition
  warnings: WorkflowNodeReferenceWarning[]
  safe: boolean
}

export interface WorkflowPortRename {
  nodeId: string
  fromPortName: string
  toPortName: string
}

export interface WorkflowPortReference {
  nodeId: string
  portName: string
}

type PortRefValue = { nodeId: string; portName: string }

interface NodeReferencePolicy {
  mapNodeId: (
    referencedNodeId: string,
    ownerNodeId: string,
    field: string,
    action: 'filter',
  ) => string | null
  mapPortRef: (
    ref: PortRefValue,
    ownerNodeId: string,
    field: string,
    action: 'clear',
  ) => PortRefValue | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field)
}

function cloneJsonValue<T>(value: T): T {
  // WorkflowDefinition is JSON data, but the shared tsconfig intentionally
  // excludes DOM globals (so structuredClone is not available in its type
  // universe). Clone recursively to preserve optional `undefined` values and
  // unknown passthrough fields without aliasing nested input objects.
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry)) as T
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
    ) as T
  }
  return value
}

function descriptorFor(node: WorkflowNode): WorkflowNodeReferenceDescriptor {
  return WORKFLOW_NODE_REFERENCE_INVENTORY[node.kind]
}

function readStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function portRefAt(value: unknown): PortRefValue | null {
  if (!isRecord(value)) return null
  return typeof value.nodeId === 'string' && typeof value.portName === 'string'
    ? { nodeId: value.nodeId, portName: value.portName }
    : null
}

function pushWarning(
  warnings: WorkflowNodeReferenceWarning[],
  warning: WorkflowNodeReferenceWarning,
): void {
  const duplicate = warnings.some(
    (candidate) =>
      candidate.code === warning.code &&
      candidate.nodeId === warning.nodeId &&
      candidate.edgeId === warning.edgeId &&
      candidate.field === warning.field &&
      candidate.referencedNodeId === warning.referencedNodeId &&
      candidate.referencedPortName === warning.referencedPortName,
  )
  if (!duplicate) warnings.push(warning)
}

function referencedNodeIdHint(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hint = referencedNodeIdHint(entry)
      if (hint !== undefined) return hint
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (typeof value.nodeId === 'string') return value.nodeId
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /nodeId$/i.test(key)) return child
    const hint = referencedNodeIdHint(child)
    if (hint !== undefined) return hint
  }
  return undefined
}

/**
 * Passthrough schemas let legacy/corrupt values reach these helpers. An
 * inventoried path must not suppress the unmanaged-field ratchet unless its
 * reference shape is actually readable. Reference-free draft containers
 * (`inputSource: {}` / `exitCondition: { kind: ... }`) remain copyable.
 */
function malformedInventoriedReferenceWarnings(node: WorkflowNode): WorkflowNodeReferenceWarning[] {
  const descriptor = descriptorFor(node)
  const record = node as Record<string, unknown>
  const warnings: WorkflowNodeReferenceWarning[] = []

  const report = (field: string, value: unknown, expected: string): void => {
    const referencedNodeId = referencedNodeIdHint(value)
    pushWarning(warnings, {
      code: 'node-reference-inventory-malformed',
      nodeId: node.id,
      field,
      ...(referencedNodeId !== undefined ? { referencedNodeId } : {}),
      action: 'abort',
      message: `node '${node.id}' inventoried reference field '${field}' has malformed ${expected} shape`,
    })
  }

  for (const field of descriptor.nodeIdLists) {
    if (!hasOwn(record, field)) continue
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) {
      report(field, value, 'node-id list')
      continue
    }
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'string') report(`${field}[${index}]`, entry, 'node-id')
    }
  }

  const inspectPortRefField = (field: string): void => {
    if (!hasOwn(record, field)) return
    const value = record[field]
    if (value === undefined || value === null || portRefAt(value) !== null) return
    // An object without either PortRef key is an incomplete, reference-free
    // editor draft. Any partial PortRef (or non-object value) is ambiguous and
    // must abort rather than retain an old id under an inventoried path.
    if (isRecord(value) && !hasOwn(value, 'nodeId') && !hasOwn(value, 'portName')) return
    report(field, value, 'PortRef')
  }
  for (const field of descriptor.directPortRefs) inspectPortRefField(field)
  for (const field of descriptor.embeddedPortRefs) inspectPortRefField(field)

  for (const field of descriptor.bindingLists) {
    if (!hasOwn(record, field)) continue
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) {
      report(field, value, 'binding list')
      continue
    }
    for (const [index, binding] of value.entries()) {
      const bindingPath = `${field}[${index}]`
      if (!isRecord(binding)) {
        report(bindingPath, binding, 'binding')
        continue
      }
      if (!hasOwn(binding, 'bind')) {
        // A draft `{ name }` row contains no reference yet. A reference-like
        // value at the wrong level is malformed and must not bypass rewriting.
        if (referencedNodeIdHint(binding) !== undefined) report(bindingPath, binding, 'binding')
        continue
      }
      const bind = binding.bind
      if (bind === undefined || bind === null || portRefAt(bind) !== null) continue
      if (isRecord(bind) && !hasOwn(bind, 'nodeId') && !hasOwn(bind, 'portName')) continue
      report(`${bindingPath}.bind`, bind, 'PortRef')
    }
  }

  return warnings
}

function unmanagedReferenceWarnings(node: WorkflowNode): WorkflowNodeReferenceWarning[] {
  const descriptor = descriptorFor(node)
  const knownNodeIdLists = new Set(descriptor.nodeIdLists)
  const knownPortRefPaths = new Set([
    ...descriptor.directPortRefs,
    ...descriptor.embeddedPortRefs,
    ...descriptor.bindingLists.map((field) => `${field}[].bind`),
  ])
  const warnings: WorkflowNodeReferenceWarning[] = []

  const report = (field: string, referencedNodeId?: string): void => {
    pushWarning(warnings, {
      code: 'node-reference-inventory-unmanaged',
      nodeId: node.id,
      field,
      ...(referencedNodeId !== undefined ? { referencedNodeId } : {}),
      action: 'abort',
      message: `node '${node.id}' has reference-like passthrough field '${field}' that is absent from WORKFLOW_NODE_REFERENCE_INVENTORY`,
    })
  }

  const walk = (value: unknown, path: string): void => {
    // Inventoried node-id lists are fully shape-checked above; every valid
    // member is the declared reference itself, so there is no unknown subtree
    // to ratchet here.
    if (knownNodeIdLists.has(path)) return
    // A known PortRef container only owns its declared `nodeId`/`portName`
    // leaves. Continue walking every passthrough key: otherwise a future
    // nested reference can hide inside an otherwise-valid known field and
    // silently bypass the inventory.
    if (knownPortRefPaths.has(path)) {
      if (!isRecord(value)) return
      for (const [key, child] of Object.entries(value)) {
        if (key === 'nodeId' || key === 'portName') continue
        walk(child, `${path}.${key}`)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, `${path}[]`)
      return
    }
    if (!isRecord(value)) return

    const ref = portRefAt(value)
    if (ref !== null) {
      report(path, ref.nodeId)
      return
    }

    for (const [key, child] of Object.entries(value)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`
      if (typeof child === 'string' && /nodeId$/i.test(key)) {
        report(childPath, child)
        continue
      }
      if (Array.isArray(child) && (/nodeIds?$/i.test(key) || /rerunnable/i.test(key))) {
        const referenced = child.find((entry): entry is string => typeof entry === 'string')
        report(childPath, referenced)
        continue
      }
      walk(child, childPath)
    }
  }

  const record = node as Record<string, unknown>
  for (const [field, value] of Object.entries(record)) {
    if (field === 'id' || field === 'kind') continue
    if (typeof value === 'string' && /nodeId$/i.test(field)) {
      report(field, value)
      continue
    }
    if (
      Array.isArray(value) &&
      (/nodeIds?$/i.test(field) || /rerunnable/i.test(field)) &&
      !knownNodeIdLists.has(field)
    ) {
      const referenced = value.find((entry): entry is string => typeof entry === 'string')
      report(field, referenced)
      continue
    }
    walk(value, field)
  }
  return warnings
}

function transformNodeReferences(
  node: WorkflowNode,
  policy: NodeReferencePolicy,
): RewrittenWorkflowNodeResult {
  const warnings = [
    ...malformedInventoriedReferenceWarnings(node),
    ...unmanagedReferenceWarnings(node),
  ]
  const cloned = cloneJsonValue(node)
  const record = cloned as Record<string, unknown>
  const descriptor = descriptorFor(node)

  for (const field of descriptor.nodeIdLists) {
    const value = record[field]
    if (!Array.isArray(value)) continue
    const next: unknown[] = []
    for (const entry of value) {
      if (typeof entry !== 'string') {
        next.push(entry)
        continue
      }
      const mapped = policy.mapNodeId(entry, node.id, field, 'filter')
      if (mapped !== null) next.push(mapped)
    }
    record[field] = next
  }

  for (const field of descriptor.directPortRefs) {
    const current = record[field]
    const ref = portRefAt(current)
    if (ref === null || !isRecord(current)) continue
    const mapped = policy.mapPortRef(ref, node.id, field, 'clear')
    current.nodeId = mapped?.nodeId ?? ''
    current.portName = mapped?.portName ?? ''
  }

  for (const field of descriptor.embeddedPortRefs) {
    const current = record[field]
    const ref = portRefAt(current)
    if (ref === null || !isRecord(current)) continue
    const mapped = policy.mapPortRef(ref, node.id, field, 'clear')
    current.nodeId = mapped?.nodeId ?? ''
    current.portName = mapped?.portName ?? ''
  }

  for (const field of descriptor.bindingLists) {
    const bindings = record[field]
    if (!Array.isArray(bindings)) continue
    for (const [index, binding] of bindings.entries()) {
      if (!isRecord(binding) || !isRecord(binding.bind)) continue
      const ref = portRefAt(binding.bind)
      if (ref === null) continue
      const path = `${field}[${index}].bind`
      const mapped = policy.mapPortRef(ref, node.id, path, 'clear')
      binding.bind.nodeId = mapped?.nodeId ?? ''
      binding.bind.portName = mapped?.portName ?? ''
    }
  }

  return {
    node: cloned,
    warnings,
    safe: warnings.every((warning) => warning.action !== 'abort'),
  }
}

/**
 * Expand selected roots through wrapper-git / wrapper-loop / wrapper-fanout
 * nodeIds recursively. Missing legacy children and membership cycles are
 * truncated with structured warnings; valid forward references work because
 * the complete node index is built before traversal.
 */
export function collectNodeReferenceClosure(
  definition: WorkflowDefinition,
  rootNodeIds: Iterable<string>,
): WorkflowNodeClosureResult {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  const included = new Set<string>()
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []
  const warnings: WorkflowNodeReferenceWarning[] = []

  const visit = (nodeId: string, ownerNodeId?: string): void => {
    const node = byId.get(nodeId)
    if (node === undefined) {
      pushWarning(warnings, {
        code: 'wrapper-child-missing',
        ...(ownerNodeId !== undefined ? { nodeId: ownerNodeId } : {}),
        field: ownerNodeId === undefined ? 'selection' : 'nodeIds',
        referencedNodeId: nodeId,
        action: 'filter',
        message:
          ownerNodeId === undefined
            ? `selected node '${nodeId}' does not exist`
            : `wrapper '${ownerNodeId}' references missing child '${nodeId}'`,
      })
      return
    }
    if (visiting.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId)
      const cycle = [...path.slice(Math.max(0, cycleStart)), nodeId]
      pushWarning(warnings, {
        code: 'wrapper-membership-cycle',
        ...(ownerNodeId !== undefined ? { nodeId: ownerNodeId } : {}),
        field: 'nodeIds',
        referencedNodeId: nodeId,
        action: 'filter',
        message: `wrapper membership cycle detected: ${cycle.join(' -> ')}`,
        cycle,
      })
      return
    }
    if (visited.has(nodeId)) return

    included.add(nodeId)
    visiting.add(nodeId)
    path.push(nodeId)
    if (isWrapperKind(node.kind)) {
      const children = readStringArray(node as Record<string, unknown>, 'nodeIds')
      for (const childId of children) visit(childId, node.id)
    }
    path.pop()
    visiting.delete(nodeId)
    visited.add(nodeId)
  }

  for (const rootId of rootNodeIds) visit(rootId)
  return {
    nodeIds: definition.nodes.filter((node) => included.has(node.id)).map((node) => node.id),
    warnings,
  }
}

function copyPolicy(
  idMap: ReadonlyMap<string, string>,
  warnings: WorkflowNodeReferenceWarning[],
): NodeReferencePolicy {
  const resolve = (
    referencedNodeId: string,
    ownerNodeId: string,
    field: string,
    action: 'clear' | 'filter',
  ): string | null => {
    const mapped = idMap.get(referencedNodeId)
    if (mapped !== undefined) return mapped
    pushWarning(warnings, {
      code: 'copy-reference-outside-slice',
      nodeId: ownerNodeId,
      field,
      referencedNodeId,
      action,
      message: `copied node '${ownerNodeId}' field '${field}' references '${referencedNodeId}' outside the copied slice`,
    })
    return null
  }
  return {
    mapNodeId: (referencedNodeId, ownerNodeId, field) =>
      resolve(referencedNodeId, ownerNodeId, field, 'filter'),
    mapPortRef: (ref, ownerNodeId, field) => {
      const nodeId = resolve(ref.nodeId, ownerNodeId, field, 'clear')
      return nodeId === null ? null : { nodeId, portName: ref.portName }
    },
  }
}

/** Rewrite every inventoried reference inside one copied node; does not change node.id. */
export function rewriteCopiedNodeReferences(
  node: WorkflowNode,
  idMap: ReadonlyMap<string, string>,
): RewrittenWorkflowNodeResult {
  const externalWarnings: WorkflowNodeReferenceWarning[] = []
  const result = transformNodeReferences(node, copyPolicy(idMap, externalWarnings))
  return {
    node: result.node,
    warnings: [...result.warnings, ...externalWarnings],
    safe: result.safe,
  }
}

/**
 * Second-pass clipboard rewrite after the caller has minted the complete idMap.
 * Nodes without an own mapping and edges with an external endpoint are dropped
 * fail-closed. Kept edges are deep-cloned, including their boundary marker.
 */
export function rewriteCopiedWorkflowSlice(
  slice: WorkflowNodeSlice,
  idMap: ReadonlyMap<string, string>,
): RewrittenWorkflowNodeSlice {
  const warnings: WorkflowNodeReferenceWarning[] = []
  const nodes: WorkflowNode[] = []
  let safe = true

  for (const source of slice.nodes) {
    const newId = idMap.get(source.id)
    if (newId === undefined) {
      pushWarning(warnings, {
        code: 'copy-node-id-unmapped',
        nodeId: source.id,
        field: 'id',
        referencedNodeId: source.id,
        action: 'drop',
        message: `copied node '${source.id}' has no entry in the complete idMap`,
      })
      safe = false
      continue
    }
    const rewritten = rewriteCopiedNodeReferences(source, idMap)
    rewritten.node.id = newId
    nodes.push(rewritten.node)
    warnings.push(...rewritten.warnings)
    safe &&= rewritten.safe
  }

  const edges: WorkflowEdge[] = []
  for (const source of slice.edges) {
    const mappedSource = idMap.get(source.source.nodeId)
    const mappedTarget = idMap.get(source.target.nodeId)
    if (mappedSource === undefined || mappedTarget === undefined) {
      const missingSource = mappedSource === undefined
      const missingNodeId = missingSource ? source.source.nodeId : source.target.nodeId
      pushWarning(warnings, {
        code: 'copy-reference-outside-slice',
        edgeId: source.id,
        field: missingSource ? 'source' : 'target',
        referencedNodeId: missingNodeId,
        action: 'drop',
        message: `copied edge '${source.id}' references '${missingNodeId}' outside the copied slice`,
      })
      continue
    }
    const edge = cloneJsonValue(source)
    edge.source.nodeId = mappedSource
    edge.target.nodeId = mappedTarget
    edges.push(edge)
  }

  return { nodes, edges, warnings, safe }
}

function survivorPolicy(
  survivorNodeIds: ReadonlySet<string>,
  warnings: WorkflowNodeReferenceWarning[],
): NodeReferencePolicy {
  const survive = (
    referencedNodeId: string,
    ownerNodeId: string,
    field: string,
    action: 'clear' | 'filter',
  ): string | null => {
    if (survivorNodeIds.has(referencedNodeId)) return referencedNodeId
    pushWarning(warnings, {
      code: 'deleted-node-reference-pruned',
      nodeId: ownerNodeId,
      field,
      referencedNodeId,
      action,
      message: `surviving node '${ownerNodeId}' field '${field}' referenced deleted node '${referencedNodeId}'`,
    })
    return null
  }
  return {
    mapNodeId: (referencedNodeId, ownerNodeId, field) =>
      survive(referencedNodeId, ownerNodeId, field, 'filter'),
    mapPortRef: (ref, ownerNodeId, field) => {
      const nodeId = survive(ref.nodeId, ownerNodeId, field, 'clear')
      return nodeId === null ? null : ref
    },
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function clearUnlockedWrapperSizeAfterMembershipPrune(
  before: WorkflowNode,
  after: WorkflowNode,
): void {
  if (!isWrapperKind(before.kind)) return
  const beforeIds = readStringArray(before as Record<string, unknown>, 'nodeIds')
  const afterRecord = after as Record<string, unknown>
  const afterIds = readStringArray(afterRecord, 'nodeIds')
  if (sameStrings(beforeIds, afterIds)) return

  const size = afterRecord.size
  if (isRecord(size) && size.sizeLocked === true) return
  delete afterRecord.size
}

/**
 * Apply a final survivor set: remove non-surviving nodes/incident edges, prune
 * every inventoried reference on surviving nodes, and drop stale top-level
 * workflow outputs. PortRef-bearing node fields remain present but are cleared
 * to `{ nodeId: '', portName: '' }` so validation can focus the repair field.
 */
export function pruneDeletedNodeReferences(
  definition: WorkflowDefinition,
  survivorNodeIds: ReadonlySet<string>,
): WorkflowDefinitionReferenceResult {
  const base = cloneJsonValue(definition)
  const warnings: WorkflowNodeReferenceWarning[] = []
  const nodes: WorkflowNode[] = []
  let safe = true
  const policy = survivorPolicy(survivorNodeIds, warnings)

  for (const node of base.nodes) {
    if (!survivorNodeIds.has(node.id)) continue
    const transformed = transformNodeReferences(node, policy)
    clearUnlockedWrapperSizeAfterMembershipPrune(node, transformed.node)
    nodes.push(transformed.node)
    warnings.push(...transformed.warnings)
    safe &&= transformed.safe
  }

  const edges = base.edges.filter((edge) => {
    const sourceSurvives = survivorNodeIds.has(edge.source.nodeId)
    const targetSurvives = survivorNodeIds.has(edge.target.nodeId)
    if (sourceSurvives && targetSurvives) return true
    const missingSource = !sourceSurvives
    const missingNodeId = missingSource ? edge.source.nodeId : edge.target.nodeId
    pushWarning(warnings, {
      code: 'deleted-node-reference-pruned',
      edgeId: edge.id,
      field: missingSource ? 'source' : 'target',
      referencedNodeId: missingNodeId,
      action: 'drop',
      message: `edge '${edge.id}' referenced deleted node '${missingNodeId}'`,
    })
    return false
  })

  const outputs = base.outputs?.filter((output, index) => {
    if (survivorNodeIds.has(output.bind.nodeId)) return true
    pushWarning(warnings, {
      code: 'deleted-node-reference-pruned',
      field: `outputs[${index}].bind`,
      referencedNodeId: output.bind.nodeId,
      action: 'drop',
      message: `workflow output '${output.name}' referenced deleted node '${output.bind.nodeId}'`,
    })
    return false
  })

  return {
    definition: {
      ...base,
      nodes,
      edges,
      ...(outputs !== undefined ? { outputs } : {}),
    },
    warnings,
    safe,
  }
}

function portRenameKey(nodeId: string, portName: string): string {
  return `${nodeId}\u0000${portName}`
}

/**
 * Remove references to derived ports that no longer exist. Edges and
 * top-level workflow outputs are dropped; inventoried node PortRefs are kept
 * as explicit incomplete values so validation can focus the repair field.
 * The same descriptor inventory/ratchet used by copy, delete, and rename is
 * deliberately reused here.
 */
export function pruneWorkflowPortReferences(
  definition: WorkflowDefinition,
  removedPorts: readonly WorkflowPortReference[],
): WorkflowDefinitionReferenceResult {
  const removed = new Set(removedPorts.map((port) => portRenameKey(port.nodeId, port.portName)))
  if (removed.size === 0) {
    return { definition, warnings: [], safe: true }
  }

  const base = cloneJsonValue(definition)
  const warnings: WorkflowNodeReferenceWarning[] = []
  const isRemoved = (ref: PortRefValue): boolean =>
    removed.has(portRenameKey(ref.nodeId, ref.portName))
  const policy: NodeReferencePolicy = {
    mapNodeId: (nodeId) => nodeId,
    mapPortRef: (ref, ownerNodeId, field) => {
      if (!isRemoved(ref)) return ref
      pushWarning(warnings, {
        code: 'disappeared-port-reference-pruned',
        nodeId: ownerNodeId,
        field,
        referencedNodeId: ref.nodeId,
        referencedPortName: ref.portName,
        action: 'clear',
        message: `node '${ownerNodeId}' field '${field}' referenced disappeared port '${ref.nodeId}.${ref.portName}'`,
      })
      return null
    },
  }

  let safe = true
  const nodes = base.nodes.map((node) => {
    const transformed = transformNodeReferences(node, policy)
    warnings.push(...transformed.warnings)
    safe &&= transformed.safe
    return transformed.node
  })
  const edges = base.edges.filter((edge) => {
    const endpoint = isRemoved(edge.source)
      ? { field: 'source', ref: edge.source }
      : isRemoved(edge.target)
        ? { field: 'target', ref: edge.target }
        : null
    if (endpoint === null) return true
    pushWarning(warnings, {
      code: 'disappeared-port-reference-pruned',
      edgeId: edge.id,
      field: endpoint.field,
      referencedNodeId: endpoint.ref.nodeId,
      referencedPortName: endpoint.ref.portName,
      action: 'drop',
      message: `edge '${edge.id}' referenced disappeared port '${endpoint.ref.nodeId}.${endpoint.ref.portName}'`,
    })
    return false
  })
  const outputs = base.outputs?.filter((output, index) => {
    if (!isRemoved(output.bind)) return true
    pushWarning(warnings, {
      code: 'disappeared-port-reference-pruned',
      field: `outputs[${index}].bind`,
      referencedNodeId: output.bind.nodeId,
      referencedPortName: output.bind.portName,
      action: 'drop',
      message: `workflow output '${output.name}' referenced disappeared port '${output.bind.nodeId}.${output.bind.portName}'`,
    })
    return false
  })

  return {
    definition: {
      ...base,
      nodes,
      edges,
      ...(outputs !== undefined ? { outputs } : {}),
    },
    warnings,
    safe,
  }
}

/**
 * Rewrite a node-scoped port name across every PortRef surface. Intended for
 * input-key remapping after paste, but generic enough for future semantic port
 * renames. It deliberately does not alter input declarations or node fields.
 */
export function rewriteWorkflowPortReferences(
  definition: WorkflowDefinition,
  renames: readonly WorkflowPortRename[],
): WorkflowDefinitionReferenceResult {
  const renameMap = new Map(
    renames.map((rename) => [portRenameKey(rename.nodeId, rename.fromPortName), rename.toPortName]),
  )
  const mapRef = (ref: PortRefValue): PortRefValue => ({
    nodeId: ref.nodeId,
    portName: renameMap.get(portRenameKey(ref.nodeId, ref.portName)) ?? ref.portName,
  })
  const policy: NodeReferencePolicy = {
    mapNodeId: (nodeId) => nodeId,
    mapPortRef: (ref) => mapRef(ref),
  }
  const base = cloneJsonValue(definition)
  const warnings: WorkflowNodeReferenceWarning[] = []
  let safe = true
  const nodes = base.nodes.map((node) => {
    const transformed = transformNodeReferences(node, policy)
    warnings.push(...transformed.warnings)
    safe &&= transformed.safe
    return transformed.node
  })
  const edges = base.edges.map((edge) => {
    const cloned = cloneJsonValue(edge)
    cloned.source = mapRef(cloned.source)
    cloned.target = mapRef(cloned.target)
    return cloned
  })
  const outputs = base.outputs?.map((output) => ({
    ...output,
    bind: mapRef(output.bind),
  }))

  return {
    definition: {
      ...base,
      nodes,
      edges,
      ...(outputs !== undefined ? { outputs } : {}),
    },
    warnings,
    safe,
  }
}
