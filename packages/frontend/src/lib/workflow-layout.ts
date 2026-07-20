import dagre from '@dagrejs/dagre'
import {
  declaredPorts,
  isSystemChannelEdge,
  isWrapperKind,
  tryHandlerForParsedKind,
  tryParseKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'
import {
  AUTO_FIT_BOTTOM_CLEARANCE,
  AUTO_FIT_LEFT_CLEARANCE,
  AUTO_FIT_RIGHT_CLEARANCE,
  AUTO_FIT_TOP_CLEARANCE,
  computeFitBounds,
  DEFAULT_NODE_SIZE_BY_KIND,
  fitWrapperToInner,
} from '@/components/canvas/wrapperFit'
import { effectiveWorkflowNodePosition } from '@/lib/workflow-placement'
import type { WorkflowSemanticContext } from '@/lib/workflow-connection-plan'

const ROOT_SCOPE = '__workflow_root__'
const HORIZONTAL_GAP = 120
const VERTICAL_GAP = 52

export type WorkflowLayoutSelection =
  | { mode: 'all' }
  | { mode: 'selection'; nodeIds: readonly string[] }

export interface WorkflowLayoutOptions {
  semanticContext: WorkflowSemanticContext
  measuredSizes?: ReadonlyMap<string, { width: number; height: number }>
  selection?: WorkflowLayoutSelection
}

export interface WorkflowLayoutWarning {
  code: 'cross-scope-selection' | 'cycle-back-edge' | 'size-locked-overflow'
  nodeIds?: string[]
  edgeId?: string
  wrapperNodeId?: string
}

export interface WorkflowLayoutPlan {
  next: WorkflowDefinition
  warnings: WorkflowLayoutWarning[]
}

export interface WorkflowLayoutDependency {
  scopeId: string | null
  sourceNodeId: string
  targetNodeId: string
  edgeId: string
  control: boolean
}

interface NodeState {
  node: WorkflowNode
  index: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function readNodeIds(node: WorkflowNode): string[] {
  const raw = (node as unknown as { nodeIds?: unknown }).nodeIds
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

function readSize(
  node: WorkflowNode,
): { width: number; height: number; sizeLocked: boolean } | undefined {
  const raw = (node as unknown as { size?: unknown }).size
  if (typeof raw !== 'object' || raw === null) return undefined
  const size = raw as { width?: unknown; height?: unknown; sizeLocked?: unknown }
  if (typeof size.width !== 'number' || typeof size.height !== 'number') return undefined
  return { width: size.width, height: size.height, sizeLocked: size.sizeLocked === true }
}

function buildParentMap(definition: WorkflowDefinition): Map<string, string> {
  const parents = new Map<string, string>()
  for (const node of definition.nodes) {
    if (!isWrapperKind(node.kind)) continue
    for (const childId of readNodeIds(node)) parents.set(childId, node.id)
  }
  return parents
}

function scopeKey(scopeId: string | null): string {
  return scopeId ?? ROOT_SCOPE
}

function scopeOf(nodeId: string, parents: ReadonlyMap<string, string>): string | null {
  return parents.get(nodeId) ?? null
}

function commonScope(
  sourceNodeId: string,
  targetNodeId: string,
  parents: ReadonlyMap<string, string>,
): string | null {
  const targetScopes = new Set<string | null>()
  let targetScope: string | null = scopeOf(targetNodeId, parents)
  const targetSeen = new Set<string>()
  while (true) {
    targetScopes.add(targetScope)
    if (targetScope === null || targetSeen.has(targetScope)) break
    targetSeen.add(targetScope)
    targetScope = scopeOf(targetScope, parents)
  }

  let sourceScope: string | null = scopeOf(sourceNodeId, parents)
  const sourceSeen = new Set<string>()
  while (!targetScopes.has(sourceScope)) {
    if (sourceScope === null || sourceSeen.has(sourceScope)) return null
    sourceSeen.add(sourceScope)
    sourceScope = scopeOf(sourceScope, parents)
  }
  return sourceScope
}

function representativeAtScope(
  nodeId: string,
  scopeId: string | null,
  parents: ReadonlyMap<string, string>,
): string | null {
  let current = nodeId
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current)) return null
    seen.add(current)
    const parent = scopeOf(current, parents)
    if (parent === scopeId) return current
    if (parent === null) return scopeId === null ? current : null
    current = parent
  }
}

function sourceIsControl(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
  semanticContext: WorkflowSemanticContext,
): boolean {
  const source = definition.nodes.find((node) => node.id === edge.source.nodeId)
  if (source === undefined) return false
  const kind = declaredPorts(source, definition, semanticContext.agentsByName).dataOutputs.find(
    (port) => port.name === edge.source.portName,
  )?.kind
  if (kind === undefined) return false
  const parsed = tryParseKind(kind)
  if (parsed === null) return false
  const handler = tryHandlerForParsedKind(parsed)
  return handler !== null && !handler.carriesData(parsed)
}

/**
 * Project each real execution dependency into the coordinate space of its
 * endpoint LCA. Fan-out boundary mirrors and framework clarify channels are
 * excluded so one semantic dependency cannot influence rank twice.
 */
export function projectWorkflowLayoutDependencies(
  definition: WorkflowDefinition,
  semanticContext: WorkflowSemanticContext,
): WorkflowLayoutDependency[] {
  const parents = buildParentMap(definition)
  const nodeIds = new Set(definition.nodes.map((node) => node.id))
  const projected: WorkflowLayoutDependency[] = []
  for (const edge of [...definition.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    if (edge.boundary !== undefined || isSystemChannelEdge(edge)) continue
    if (!nodeIds.has(edge.source.nodeId) || !nodeIds.has(edge.target.nodeId)) continue
    const scopeId = commonScope(edge.source.nodeId, edge.target.nodeId, parents)
    const sourceNodeId = representativeAtScope(edge.source.nodeId, scopeId, parents)
    const targetNodeId = representativeAtScope(edge.target.nodeId, scopeId, parents)
    if (sourceNodeId === null || targetNodeId === null || sourceNodeId === targetNodeId) continue
    projected.push({
      scopeId,
      sourceNodeId,
      targetNodeId,
      edgeId: edge.id,
      control: sourceIsControl(definition, edge, semanticContext),
    })
  }
  return projected
}

function wrapperDepth(wrapperId: string, parents: ReadonlyMap<string, string>): number {
  let depth = 0
  let current: string | undefined = wrapperId
  const seen = new Set<string>()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    current = parents.get(current)
    if (current !== undefined) depth += 1
  }
  return depth
}

function positionOf(state: NodeState): { x: number; y: number } {
  return effectiveWorkflowNodePosition(state.node, state.index)
}

function sizeOf(
  node: WorkflowNode,
  measuredSizes: WorkflowLayoutOptions['measuredSizes'],
): { width: number; height: number } {
  const measured = measuredSizes?.get(node.id)
  if (measured !== undefined && measured.width > 0 && measured.height > 0) return measured
  const persisted = readSize(node)
  if (persisted !== undefined && persisted.width > 0 && persisted.height > 0) {
    return { width: persisted.width, height: persisted.height }
  }
  return DEFAULT_NODE_SIZE_BY_KIND[node.kind]
}

function rectOf(state: NodeState, measuredSizes: WorkflowLayoutOptions['measuredSizes']): Rect {
  return { ...positionOf(state), ...sizeOf(state.node, measuredSizes) }
}

function boundsOf(
  ids: readonly string[],
  states: ReadonlyMap<string, NodeState>,
  measuredSizes: WorkflowLayoutOptions['measuredSizes'],
): Rect | null {
  const rects = ids.flatMap((id) => {
    const state = states.get(id)
    return state === undefined ? [] : [rectOf(state, measuredSizes)]
  })
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function intersects(left: Rect, right: Rect, gap = 24): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  )
}

function hasPath(
  from: string,
  to: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const pending = [from]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === to) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) pending.push(next)
  }
  return false
}

function acceptedAcyclicDependencies(
  dependencies: readonly WorkflowLayoutDependency[],
  nodeIds: ReadonlySet<string>,
  warnings: WorkflowLayoutWarning[],
): WorkflowLayoutDependency[] {
  const accepted: WorkflowLayoutDependency[] = []
  const adjacency = new Map<string, Set<string>>()
  const dedupe = new Set<string>()
  for (const dependency of [...dependencies].sort(
    (left, right) =>
      left.sourceNodeId.localeCompare(right.sourceNodeId) ||
      left.targetNodeId.localeCompare(right.targetNodeId) ||
      left.edgeId.localeCompare(right.edgeId),
  )) {
    if (!nodeIds.has(dependency.sourceNodeId) || !nodeIds.has(dependency.targetNodeId)) continue
    const pair = `${dependency.sourceNodeId}\u0000${dependency.targetNodeId}`
    if (dedupe.has(pair)) continue
    dedupe.add(pair)
    if (hasPath(dependency.targetNodeId, dependency.sourceNodeId, adjacency)) {
      warnings.push({ code: 'cycle-back-edge', edgeId: dependency.edgeId })
      continue
    }
    accepted.push(dependency)
    const next = adjacency.get(dependency.sourceNodeId) ?? new Set<string>()
    next.add(dependency.targetNodeId)
    adjacency.set(dependency.sourceNodeId, next)
  }
  return accepted
}

function descendantClosure(rootId: string, states: ReadonlyMap<string, NodeState>): Set<string> {
  const closure = new Set<string>()
  const pending = [rootId]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (closure.has(id)) continue
    closure.add(id)
    const node = states.get(id)?.node
    if (node === undefined || !isWrapperKind(node.kind)) continue
    pending.push(...readNodeIds(node))
  }
  return closure
}

function setNodePosition(state: NodeState, position: { x: number; y: number }): NodeState {
  const previous = positionOf(state)
  if (previous.x === position.x && previous.y === position.y && state.node.position !== undefined) {
    return state
  }
  return { ...state, node: { ...state.node, position } }
}

function translateClosure(
  states: Map<string, NodeState>,
  rootId: string,
  nextRootPosition: { x: number; y: number },
): void {
  const root = states.get(rootId)
  if (root === undefined) return
  const previous = positionOf(root)
  const dx = Math.round(nextRootPosition.x - previous.x)
  const dy = Math.round(nextRootPosition.y - previous.y)
  if (dx === 0 && dy === 0) return
  for (const id of descendantClosure(rootId, states)) {
    const state = states.get(id)
    if (state === undefined) continue
    const position = positionOf(state)
    states.set(id, setNodePosition(state, { x: position.x + dx, y: position.y + dy }))
  }
}

function fitScopeWrapper(
  scopeId: string,
  childIds: readonly string[],
  states: Map<string, NodeState>,
  definition: WorkflowDefinition,
  measuredSizes: Map<string, { width: number; height: number }>,
  warnings: WorkflowLayoutWarning[],
): void {
  const wrapper = states.get(scopeId)
  if (wrapper === undefined) return
  const persisted = readSize(wrapper.node)
  if (persisted?.sizeLocked === true) {
    measuredSizes.set(scopeId, { width: persisted.width, height: persisted.height })
    const bounds = boundsOf(childIds, states, measuredSizes)
    if (bounds === null) return
    const position = positionOf(wrapper)
    const wrapperRect: Rect = {
      x: position.x,
      y: position.y,
      width: persisted.width,
      height: persisted.height,
    }
    const overflows =
      bounds.x < wrapperRect.x + AUTO_FIT_LEFT_CLEARANCE ||
      bounds.y < wrapperRect.y + AUTO_FIT_TOP_CLEARANCE ||
      bounds.x + bounds.width > wrapperRect.x + wrapperRect.width - AUTO_FIT_RIGHT_CLEARANCE ||
      bounds.y + bounds.height > wrapperRect.y + wrapperRect.height - AUTO_FIT_BOTTOM_CLEARANCE
    if (overflows) warnings.push({ code: 'size-locked-overflow', wrapperNodeId: scopeId })
    return
  }

  const nodes = definition.nodes.map((node) => states.get(node.id)?.node ?? node)
  let fittedNode: WorkflowNode | undefined
  if (persisted === undefined) {
    const fit = computeFitBounds(wrapper.node, nodes, undefined, measuredSizes)
    fittedNode = {
      ...wrapper.node,
      position: fit.offset,
      size: { width: fit.width, height: fit.height },
    }
  } else {
    const fitted = fitWrapperToInner({ ...definition, nodes }, scopeId, measuredSizes)
    fittedNode = fitted.nodes.find((node) => node.id === scopeId)
  }
  if (fittedNode === undefined) return
  states.set(scopeId, { ...wrapper, node: fittedNode })
  const fittedSize = readSize(fittedNode)
  if (fittedSize !== undefined) {
    // The captured xyflow measurement describes the pre-layout wrapper. Once
    // the canonical fit changes it, parent-scope Dagre must rank using the new
    // rectangle rather than that stale measurement. This mutates only the
    // planner's private snapshot, never the adapter-owned map.
    measuredSizes.set(scopeId, { width: fittedSize.width, height: fittedSize.height })
  }
}

function layoutScope(
  scopeId: string | null,
  targetIds: readonly string[],
  allDirectIds: readonly string[],
  dependencies: readonly WorkflowLayoutDependency[],
  states: Map<string, NodeState>,
  measuredSizes: WorkflowLayoutOptions['measuredSizes'],
  selectionMode: boolean,
  warnings: WorkflowLayoutWarning[],
): void {
  if (targetIds.length === 0) return
  const originalBounds = boundsOf(targetIds, states, measuredSizes)
  if (originalBounds === null) return
  const targetSet = new Set(targetIds)
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({
    rankdir: 'LR',
    nodesep: VERTICAL_GAP,
    ranksep: HORIZONTAL_GAP,
    marginx: 0,
    marginy: 0,
  })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const id of [...targetIds].sort()) {
    const state = states.get(id)
    if (state === undefined) continue
    // Dagre annotates each node label in place with x/y/rank metadata. Never
    // hand it one of the shared DEFAULT_NODE_SIZE_BY_KIND objects (or a caller's
    // measured-size object), otherwise one layout run mutates the next run's
    // inputs and same-kind nodes can end up sharing one coordinate.
    const size = sizeOf(state.node, measuredSizes)
    graph.setNode(id, { width: size.width, height: size.height })
  }
  for (const dependency of acceptedAcyclicDependencies(dependencies, targetSet, warnings)) {
    graph.setEdge(dependency.sourceNodeId, dependency.targetNodeId)
  }
  dagre.layout(graph)

  const laidOut = new Map<string, Rect>()
  for (const id of [...targetIds].sort()) {
    const state = states.get(id)
    const result = graph.node(id) as { x: number; y: number } | undefined
    if (state === undefined || result === undefined) continue
    const size = sizeOf(state.node, measuredSizes)
    laidOut.set(id, {
      x: result.x - size.width / 2,
      y: result.y - size.height / 2,
      ...size,
    })
  }
  if (laidOut.size === 0) return
  const rawLeft = Math.min(...[...laidOut.values()].map((rect) => rect.x))
  const rawTop = Math.min(...[...laidOut.values()].map((rect) => rect.y))
  const scope = scopeId === null ? undefined : states.get(scopeId)
  const scopePosition = scope === undefined ? undefined : positionOf(scope)
  const anchor = selectionMode
    ? { x: originalBounds.x, y: originalBounds.y }
    : scopePosition === undefined
      ? { x: originalBounds.x, y: originalBounds.y }
      : {
          x: scopePosition.x + AUTO_FIT_LEFT_CLEARANCE,
          y: scopePosition.y + AUTO_FIT_TOP_CLEARANCE,
        }
  let offsetX = anchor.x - rawLeft
  let offsetY = anchor.y - rawTop

  if (selectionMode) {
    const untouchedRects = allDirectIds
      .filter((id) => !targetSet.has(id))
      .flatMap((id) => {
        const state = states.get(id)
        return state === undefined ? [] : [rectOf(state, measuredSizes)]
      })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidateX = offsetX + (attempt % 10) * 40
      const candidateY = offsetY + Math.floor(attempt / 10) * 40
      const collision = [...laidOut.values()].some((rect) =>
        untouchedRects.some((untouched) =>
          intersects({ ...rect, x: rect.x + candidateX, y: rect.y + candidateY }, untouched),
        ),
      )
      if (!collision) {
        offsetX = candidateX
        offsetY = candidateY
        break
      }
    }
  }

  for (const [id, rect] of laidOut) {
    translateClosure(states, id, {
      x: Math.round(rect.x + offsetX),
      y: Math.round(rect.y + offsetY),
    })
  }
}

export function planWorkflowLayout(
  definition: WorkflowDefinition,
  options: WorkflowLayoutOptions,
): WorkflowLayoutPlan {
  const selection = options.selection ?? { mode: 'all' }
  const warnings: WorkflowLayoutWarning[] = []
  // Dagre and wrapper fit receive a private, immutable-at-the-boundary size
  // snapshot. Internal wrapper refits may replace their own stale measurement
  // before the parent scope is laid out.
  const measuredSizes = new Map(options.measuredSizes ?? [])
  const parents = buildParentMap(definition)
  const states = new Map(definition.nodes.map((node, index) => [node.id, { node, index }] as const))
  const dependencies = projectWorkflowLayoutDependencies(definition, options.semanticContext)
  const dependenciesByScope = new Map<string, WorkflowLayoutDependency[]>()
  for (const dependency of dependencies) {
    const key = scopeKey(dependency.scopeId)
    const rows = dependenciesByScope.get(key) ?? []
    rows.push(dependency)
    dependenciesByScope.set(key, rows)
  }
  const directChildren = (scopeId: string | null): string[] =>
    definition.nodes.filter((node) => scopeOf(node.id, parents) === scopeId).map((node) => node.id)

  if (selection.mode === 'selection') {
    const selected = [...new Set(selection.nodeIds)].filter((id) => states.has(id))
    const scopes = new Set(selected.map((id) => scopeOf(id, parents)))
    if (scopes.size > 1) {
      warnings.push({ code: 'cross-scope-selection', nodeIds: selected })
      return { next: definition, warnings }
    }
    const scopeId = scopes.values().next().value as string | null | undefined
    if (scopeId === undefined) return { next: definition, warnings }
    const allDirect = directChildren(scopeId)
    layoutScope(
      scopeId,
      selected,
      allDirect,
      dependenciesByScope.get(scopeKey(scopeId)) ?? [],
      states,
      measuredSizes,
      true,
      warnings,
    )
    if (scopeId !== null) {
      fitScopeWrapper(scopeId, allDirect, states, definition, measuredSizes, warnings)
    }
  } else {
    const wrappers = definition.nodes
      .filter((node) => isWrapperKind(node.kind))
      .sort(
        (left, right) =>
          wrapperDepth(right.id, parents) - wrapperDepth(left.id, parents) ||
          left.id.localeCompare(right.id),
      )
    for (const wrapper of wrappers) {
      const children = directChildren(wrapper.id)
      layoutScope(
        wrapper.id,
        children,
        children,
        dependenciesByScope.get(scopeKey(wrapper.id)) ?? [],
        states,
        measuredSizes,
        false,
        warnings,
      )
      fitScopeWrapper(wrapper.id, children, states, definition, measuredSizes, warnings)
    }
    const topLevel = directChildren(null)
    layoutScope(
      null,
      topLevel,
      topLevel,
      dependenciesByScope.get(ROOT_SCOPE) ?? [],
      states,
      measuredSizes,
      false,
      warnings,
    )
  }

  const nodes = definition.nodes.map((node) => states.get(node.id)?.node ?? node)
  const changed = nodes.some((node, index) => node !== definition.nodes[index])
  return { next: changed ? { ...definition, nodes } : definition, warnings }
}
