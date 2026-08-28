import {
  analyzeWorkflowScopeTree,
  isWrapperKind,
  type WorkflowDefinition,
  type WorkflowScopeTreeIssue,
} from '@agent-workflow/shared'
import type { WrapperNodeKind } from './wrapperExecution'

export interface ExecutionScopeSegment {
  readonly wrapperId: string
  readonly kind: WrapperNodeKind
}

export interface WrapperScopeDescriptor<K extends WrapperNodeKind = WrapperNodeKind> {
  readonly wrapperId: string
  readonly kind: K
  readonly parentScopeId: string | null
  readonly directNodeIds: readonly string[]
  /** Outermost wrapper first, current wrapper last. */
  readonly path: readonly ExecutionScopeSegment[]
}

export interface ExecutionScopeIndex {
  readonly rootNodeIds: ReadonlySet<string>
  readonly parentOf: ReadonlyMap<string, string>
  readonly wrappers: ReadonlyMap<string, WrapperScopeDescriptor>
  scopeOf(nodeId: string): string | null
  pathOf(nodeId: string): readonly ExecutionScopeSegment[]
  wrapper<K extends WrapperNodeKind>(wrapperId: string, kind: K): WrapperScopeDescriptor<K>
}

export class InvalidExecutionScopeError extends Error {
  constructor(readonly issue: WorkflowScopeTreeIssue) {
    super(`${issue.code}: ${JSON.stringify(issue)}`)
    this.name = 'InvalidExecutionScopeError'
  }
}

function directNodeIdsOf(node: { readonly nodeIds?: unknown }): readonly string[] {
  return Array.isArray(node.nodeIds)
    ? node.nodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string')
    : []
}

function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze({
    get size(): number {
      return source.size
    },
    get: (key: K) => source.get(key),
    has: (key: K) => source.has(key),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void) => {
      const view = readonlyMap(source)
      source.forEach((value, key) => callback(value, key, view))
    },
    [Symbol.iterator]: () => source[Symbol.iterator](),
  }) as ReadonlyMap<K, V>
}

function readonlySet<T>(source: Set<T>): ReadonlySet<T> {
  return Object.freeze({
    get size(): number {
      return source.size
    },
    has: (value: T) => source.has(value),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: T, valueAgain: T, set: ReadonlySet<T>) => void) => {
      const view = readonlySet(source)
      source.forEach((value) => callback(value, value, view))
    },
    [Symbol.iterator]: () => source[Symbol.iterator](),
  }) as ReadonlySet<T>
}

export function createExecutionScopeIndex(definition: WorkflowDefinition): ExecutionScopeIndex {
  const analysis = analyzeWorkflowScopeTree(definition)
  const issue = analysis.issues[0]
  if (issue !== undefined) throw new InvalidExecutionScopeError(issue)

  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]))
  const pathToWrapper = (wrapperId: string): readonly ExecutionScopeSegment[] => {
    const reversed: ExecutionScopeSegment[] = []
    let current: string | undefined = wrapperId
    while (current !== undefined) {
      const wrapper = nodeById.get(current)
      if (wrapper === undefined || !isWrapperKind(wrapper.kind)) {
        throw new Error(`execution-scope-wrapper-missing:${current}`)
      }
      reversed.push(Object.freeze({ wrapperId: current, kind: wrapper.kind as WrapperNodeKind }))
      current = analysis.parents.get(current)
    }
    return Object.freeze(reversed.reverse())
  }

  const wrappers = new Map<string, WrapperScopeDescriptor>()
  for (const node of definition.nodes) {
    if (!isWrapperKind(node.kind)) continue
    const kind = node.kind as WrapperNodeKind
    wrappers.set(
      node.id,
      Object.freeze({
        wrapperId: node.id,
        kind,
        parentScopeId: analysis.parents.get(node.id) ?? null,
        directNodeIds: Object.freeze([
          ...directNodeIdsOf(node as unknown as { readonly nodeIds?: unknown }),
        ]),
        path: pathToWrapper(node.id),
      }),
    )
  }

  const rootNodeIds = new Set<string>()
  for (const node of definition.nodes) {
    if (!analysis.parents.has(node.id)) rootNodeIds.add(node.id)
  }

  const parentOf = readonlyMap(new Map(analysis.parents))
  const wrapperView = readonlyMap(wrappers)
  const rootView = readonlySet(rootNodeIds)
  const EMPTY_PATH = Object.freeze([]) as readonly ExecutionScopeSegment[]
  return Object.freeze({
    rootNodeIds: rootView,
    parentOf,
    wrappers: wrapperView,
    scopeOf(nodeId: string): string | null {
      return parentOf.get(nodeId) ?? null
    },
    pathOf(nodeId: string): readonly ExecutionScopeSegment[] {
      const containingWrapper = parentOf.get(nodeId)
      return containingWrapper === undefined
        ? EMPTY_PATH
        : (wrapperView.get(containingWrapper)?.path ?? EMPTY_PATH)
    },
    wrapper<K extends WrapperNodeKind>(wrapperId: string, kind: K): WrapperScopeDescriptor<K> {
      const descriptor = wrapperView.get(wrapperId)
      if (descriptor === undefined) throw new Error(`execution-scope-wrapper-missing:${wrapperId}`)
      if (descriptor.kind !== kind) {
        throw new Error(
          `execution-scope-wrapper-kind-mismatch:${wrapperId}:${kind}:${descriptor.kind}`,
        )
      }
      return descriptor as WrapperScopeDescriptor<K>
    },
  })
}
