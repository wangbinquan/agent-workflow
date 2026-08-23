// Wrapper-scope structural projection.
//
// A workflow stores containment (`wrapper.nodeIds[]`) and data edges in one
// flat definition, while runtime scheduling executes one scope at a time. This
// module is the single structural oracle for projecting a flat dependency into
// the coordinate space of its endpoint LCA and for promoting a source reference
// through wrapper output boundaries when data leaves a wrapper.

import {
  isWrapperKind,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowNode,
  type WRAPPER_NODE_KINDS,
} from './schemas/workflow'
import type { WorkflowPortReference } from './workflow-node-references'

export interface ProjectedWorkflowDependency {
  scopeId: string | null
  sourceNodeId: string
  targetNodeId: string
}

export type WorkflowSourceRefResolution =
  | {
      ok: true
      source: WorkflowPortReference
      exitedWrapperIds: string[]
    }
  | {
      ok: false
      source: WorkflowPortReference
      wrapperId: string
      /**
       * RFC-317 T58（findings NK-02）—— 允许为 null。
       *
       * 改造前这里是 `NodeKind`，于是两处失败返回**借用**了一个业务身份：
       * `wrapper?.kind ?? 'wrapper-git'`（找不到这个节点）与直接写死 `'wrapper-git'`
       * （父 id 根本不是 wrapper 节点）。而这个字段会**原样**渲染进用户可见的诊断文案
       * （workflow.validator.ts 三处、scheduler.ts 一处）——于是一条「这个父节点不是
       * wrapper」的错误，会告诉用户问题出在一个 git wrapper 上。
       * `null` 让「不知道 / 不适用」可表达，不必再从 git 那里借。
       */
      wrapperKind: NodeKind | null
      reason: 'wrapper-output-not-exposed' | 'containment-cycle'
    }

export type WorkflowScopeTreeIssue =
  | {
      code: 'wrapper-child-duplicate'
      wrapperId: string
      childId: string
    }
  | {
      code: 'wrapper-child-node-missing'
      wrapperId: string
      childId: string
    }
  | {
      code: 'wrapper-child-multiple-parents'
      childId: string
      parentIds: string[]
    }
  | {
      code: 'wrapper-containment-cycle'
      cycle: string[]
    }

export interface WorkflowScopeTreeAnalysis {
  parents: Map<string, string>
  issues: WorkflowScopeTreeIssue[]
}

function readNodeIds(node: WorkflowNode): string[] {
  const raw = (node as unknown as { nodeIds?: unknown }).nodeIds
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

interface OutputBinding {
  name: string
  bind: WorkflowPortReference
}

function readOutputBindings(node: WorkflowNode): OutputBinding[] {
  const raw = (node as unknown as { outputBindings?: unknown }).outputBindings
  if (!Array.isArray(raw)) return []
  const bindings: OutputBinding[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string') continue
    if (record.bind === null || typeof record.bind !== 'object') continue
    const bind = record.bind as Record<string, unknown>
    if (typeof bind.nodeId !== 'string' || typeof bind.portName !== 'string') continue
    bindings.push({
      name: record.name,
      bind: { nodeId: bind.nodeId, portName: bind.portName },
    })
  }
  return bindings
}

/**
 * Analyze the wrapper containment tree once for validators and runtime gates.
 *
 * The returned parent map stays deterministic even for invalid definitions so
 * read-only consumers can still render diagnostics. Execution callers must
 * reject a non-empty `issues` list before using the map for scheduling.
 */
export function analyzeWorkflowScopeTree(
  definition: WorkflowDefinition,
): WorkflowScopeTreeAnalysis {
  const nodeIds = new Set(definition.nodes.map((node) => node.id))
  const wrapperIds = new Set(
    definition.nodes.filter((node) => isWrapperKind(node.kind)).map((node) => node.id),
  )
  const parents = new Map<string, string>()
  const parentIdsByChild = new Map<string, Set<string>>()
  const childWrappers = new Map<string, string[]>()
  const issues: WorkflowScopeTreeIssue[] = []

  for (const node of definition.nodes) {
    if (!isWrapperKind(node.kind)) continue
    const seenChildren = new Set<string>()
    const nestedWrappers: string[] = []
    for (const childId of readNodeIds(node)) {
      if (seenChildren.has(childId)) {
        issues.push({ code: 'wrapper-child-duplicate', wrapperId: node.id, childId })
        continue
      }
      seenChildren.add(childId)
      if (!nodeIds.has(childId)) {
        issues.push({ code: 'wrapper-child-node-missing', wrapperId: node.id, childId })
        continue
      }
      const parentIds = parentIdsByChild.get(childId) ?? new Set<string>()
      parentIds.add(node.id)
      parentIdsByChild.set(childId, parentIds)
      // Preserve the historical deterministic projection for diagnostics;
      // validators/runtime gates reject the ambiguity before execution.
      parents.set(childId, node.id)
      if (wrapperIds.has(childId)) nestedWrappers.push(childId)
    }
    childWrappers.set(node.id, nestedWrappers)
  }

  for (const [childId, parentIds] of parentIdsByChild) {
    if (parentIds.size < 2) continue
    issues.push({
      code: 'wrapper-child-multiple-parents',
      childId,
      parentIds: [...parentIds].sort(),
    })
  }

  const visited = new Set<string>()
  const activeIndex = new Map<string, number>()
  const path: string[] = []
  let cycle: string[] | undefined
  const visit = (wrapperId: string): void => {
    if (cycle !== undefined || visited.has(wrapperId)) return
    const index = activeIndex.get(wrapperId)
    if (index !== undefined) {
      cycle = [...path.slice(index), wrapperId]
      return
    }
    activeIndex.set(wrapperId, path.length)
    path.push(wrapperId)
    for (const childWrapperId of childWrappers.get(wrapperId) ?? []) {
      visit(childWrapperId)
      if (cycle !== undefined) break
    }
    path.pop()
    activeIndex.delete(wrapperId)
    visited.add(wrapperId)
  }
  for (const wrapperId of [...wrapperIds].sort()) {
    visit(wrapperId)
    if (cycle !== undefined) break
  }
  if (cycle !== undefined) issues.push({ code: 'wrapper-containment-cycle', cycle })

  return { parents, issues }
}

/**
 * Direct child → wrapper parent map. Valid workflow containment is a tree, so
 * each child has one parent. Invalid definitions retain a deterministic map
 * for diagnostics; execution must use {@link analyzeWorkflowScopeTree} and
 * reject its issues first.
 */
export function buildWorkflowScopeParentMap(definition: WorkflowDefinition): Map<string, string> {
  return analyzeWorkflowScopeTree(definition).parents
}

export function workflowScopeOf(
  nodeId: string,
  parents: ReadonlyMap<string, string>,
): string | null {
  return parents.get(nodeId) ?? null
}

export function commonWorkflowScope(
  sourceNodeId: string,
  targetNodeId: string,
  parents: ReadonlyMap<string, string>,
): string | null {
  const targetScopes = new Set<string | null>()
  let targetScope: string | null = workflowScopeOf(targetNodeId, parents)
  const targetSeen = new Set<string>()
  while (true) {
    targetScopes.add(targetScope)
    if (targetScope === null || targetSeen.has(targetScope)) break
    targetSeen.add(targetScope)
    targetScope = workflowScopeOf(targetScope, parents)
  }

  let sourceScope: string | null = workflowScopeOf(sourceNodeId, parents)
  const sourceSeen = new Set<string>()
  while (!targetScopes.has(sourceScope)) {
    if (sourceScope === null || sourceSeen.has(sourceScope)) return null
    sourceSeen.add(sourceScope)
    sourceScope = workflowScopeOf(sourceScope, parents)
  }
  return sourceScope
}

export function representativeAtWorkflowScope(
  nodeId: string,
  scopeId: string | null,
  parents: ReadonlyMap<string, string>,
): string | null {
  let current = nodeId
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current)) return null
    seen.add(current)
    const parent = workflowScopeOf(current, parents)
    if (parent === scopeId) return current
    if (parent === null) return scopeId === null ? current : null
    current = parent
  }
}

/** Project one flat dependency to the direct children of its endpoint LCA. */
export function projectWorkflowDependency(
  sourceNodeId: string,
  targetNodeId: string,
  parents: ReadonlyMap<string, string>,
): ProjectedWorkflowDependency | null {
  const scopeId = commonWorkflowScope(sourceNodeId, targetNodeId, parents)
  const sourceRepresentative = representativeAtWorkflowScope(sourceNodeId, scopeId, parents)
  const targetRepresentative = representativeAtWorkflowScope(targetNodeId, scopeId, parents)
  if (sourceRepresentative === null || targetRepresentative === null) return null
  return {
    scopeId,
    sourceNodeId: sourceRepresentative,
    targetNodeId: targetRepresentative,
  }
}

export function isNodeInsideWorkflowWrapper(
  nodeId: string,
  wrapperId: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  if (nodeId === wrapperId) return true
  let current: string | undefined = nodeId
  const seen = new Set<string>()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const parent = parents.get(current)
    if (parent === wrapperId) return true
    current = parent
  }
  return false
}

/**
 * 一种 wrapper 把内层端口提升到自己边界上的方式。返回 null = 这个端口过不了这道边界。
 */
type WrapperBoundaryPromoter = (
  definition: WorkflowDefinition,
  wrapper: WorkflowNode,
  source: WorkflowPortReference,
) => WorkflowPortReference | null

/**
 * RFC-317 T58（findings NK-02）—— 边界提升的**穷尽**分派表。
 *
 * 改造前这里是一条 if-chain 加一个隐式默认（末尾裸 `return null`），而它所在的模块
 * 自称「唯一的结构预言」。加第四种 wrapper kind 时，它会**静默**落进那个 `return null`
 * ——表现为「这个 wrapper 的所有内层端口都过不了边界」，而不是任何一处编译错误。
 *
 * 改成 `satisfies Record<WrapperKind, …>` 之后，漏一个 kind 是编译错误；
 * `wrapper-git` 那条从「掉进默认」变成一条**显式**的 `() => null`，理由写在它自己身上。
 */
const WRAPPER_BOUNDARY_PROMOTERS = {
  // git wrapper 只暴露它自己生成的 `git_diff`，任意内层端口都不能穿过这道边界。
  // 这不是「还没实现」，是设计如此——所以它显式写成 null，而不是掉进默认分支。
  'wrapper-git': () => null,

  'wrapper-loop': (_definition, wrapper, source) => {
    const binding = readOutputBindings(wrapper)
      .filter(
        (candidate) =>
          candidate.bind.nodeId === source.nodeId && candidate.bind.portName === source.portName,
      )
      .sort((left, right) => left.name.localeCompare(right.name))[0]
    return binding === undefined ? null : { nodeId: wrapper.id, portName: binding.name }
  },

  'wrapper-fanout': (definition, wrapper, source) => {
    const boundary = definition.edges
      .filter(
        (edge) =>
          edge.boundary === 'wrapper-output' &&
          edge.source.nodeId === source.nodeId &&
          edge.source.portName === source.portName &&
          edge.target.nodeId === wrapper.id,
      )
      .sort(
        (left, right) =>
          left.target.portName.localeCompare(right.target.portName) ||
          left.id.localeCompare(right.id),
      )[0]
    return boundary === undefined ? null : { ...boundary.target }
  },
} as const satisfies Record<(typeof WRAPPER_NODE_KINDS)[number], WrapperBoundaryPromoter>

/**
 * RFC-317 T58（findings NK-02）—— `wrapperKind` 渲染进用户文案时的**唯一**写法。
 *
 * 该字段现在可为 null（「不知道 / 不适用」）。四个消费点都把它直接插进诊断串
 * （workflow.validator.ts ×3、scheduler.ts ×1），各写各的 `?? '...'` 会让同一种情况
 * 在四条错误里说法不同。这里收成一处：未知时说「wrapper」这个通名，
 * 而不是像改造前那样借用 `wrapper-git` 的身份——那会让「父节点不是 wrapper」这种错误
 * 告诉用户问题出在一个 git wrapper 上。
 */
export function describeWrapperKind(kind: NodeKind | null): string {
  return kind ?? 'wrapper'
}

function promotedSourceForWrapper(
  definition: WorkflowDefinition,
  wrapper: WorkflowNode,
  source: WorkflowPortReference,
): WorkflowPortReference | null {
  const promote = WRAPPER_BOUNDARY_PROMOTERS[wrapper.kind as (typeof WRAPPER_NODE_KINDS)[number]]
  // 调用点已经 `isWrapperKind(wrapper.kind)` 过；这里的 undefined 只可能来自
  // 「WRAPPER_NODE_KINDS 与 isWrapperKind 脱节」，那是应当大声失败的内部不一致。
  if (promote === undefined) return null
  return promote(definition, wrapper, source)
}

/**
 * Resolve the source row/port a consumer must actually read.
 *
 * When the source leaves a wrapper, every crossed wrapper must expose that
 * value on its own output boundary. The returned reference points at the
 * outermost promoted wrapper row, so provenance and stale re-dispatch follow
 * the same atomic boundary as scheduling. Missing exposure fails closed.
 */
export function resolveWorkflowSourceRef(
  definition: WorkflowDefinition,
  source: WorkflowPortReference,
  targetNodeId: string,
  parents: ReadonlyMap<string, string> = buildWorkflowScopeParentMap(definition),
): WorkflowSourceRefResolution {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]))
  let current = { ...source }
  const exitedWrapperIds: string[] = []
  const seen = new Set<string>()

  while (true) {
    const parentId = parents.get(current.nodeId)
    if (parentId === undefined || isNodeInsideWorkflowWrapper(targetNodeId, parentId, parents)) {
      return { ok: true, source: current, exitedWrapperIds }
    }
    if (seen.has(parentId)) {
      const wrapper = nodeById.get(parentId)
      return {
        ok: false,
        source: current,
        wrapperId: parentId,
        wrapperKind: wrapper?.kind ?? null,
        reason: 'containment-cycle',
      }
    }
    seen.add(parentId)
    const wrapper = nodeById.get(parentId)
    if (wrapper === undefined || !isWrapperKind(wrapper.kind)) {
      return {
        ok: false,
        source: current,
        wrapperId: parentId,
        wrapperKind: null,
        reason: 'wrapper-output-not-exposed',
      }
    }
    const promoted = promotedSourceForWrapper(definition, wrapper, current)
    if (promoted === null) {
      return {
        ok: false,
        source: current,
        wrapperId: wrapper.id,
        wrapperKind: wrapper.kind,
        reason: 'wrapper-output-not-exposed',
      }
    }
    exitedWrapperIds.push(wrapper.id)
    current = promoted
  }
}
