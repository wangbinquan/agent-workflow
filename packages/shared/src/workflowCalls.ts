// RFC-243 §3.1/§5.4 — call-node reference extraction and cross-definition
// cycle detection. Pure, resolver-injected (zero IO); the backend launch
// closure walk and the validator's 4f rules both consume these so the two
// gates cannot drift.
//
// Cycle payload discipline (design-gate P2-6): cycles are reported as
// RESOURCE IDS only — names are display data the reporter may not be allowed
// to echo (RFC-099 D1); the caller decides how much of the path is visible.

import type { WorkflowDefinition, WorkflowNode } from './schemas/workflow'

/** The call-node selector as authored: name is authoritative, id is a cache. */
export interface WorkflowCallRef {
  nodeId: string
  workflowName: string
  workflowId?: string
}

function readStr(node: WorkflowNode, key: string): string | undefined {
  const v = (node as unknown as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Every call-workflow reference in one definition (declaration order). */
export function collectWorkflowCallRefs(defn: WorkflowDefinition): WorkflowCallRef[] {
  const out: WorkflowCallRef[] = []
  for (const node of defn.nodes) {
    if (node.kind !== 'call-workflow') continue
    const workflowName = readStr(node, 'workflowName')
    if (workflowName === undefined) continue // malformed node — validator owns the error
    const workflowId = readStr(node, 'workflowId')
    out.push({ nodeId: node.id, workflowName, ...(workflowId ? { workflowId } : {}) })
  }
  return out
}

/** RFC-243 PR-4 — call-workgroup selector (workgroups are closure LEAVES:
 *  the dw validator rejects call nodes in generated DAGs, so a workgroup can
 *  never re-open the reference graph at runtime). */
export interface WorkgroupCallRef {
  nodeId: string
  workgroupName: string
  workgroupId?: string
}

export function collectWorkgroupCallRefs(defn: WorkflowDefinition): WorkgroupCallRef[] {
  const out: WorkgroupCallRef[] = []
  for (const node of defn.nodes) {
    if (node.kind !== 'call-workgroup') continue
    const workgroupName = readStr(node, 'workgroupName')
    if (workgroupName === undefined) continue
    const workgroupId = readStr(node, 'workgroupId')
    out.push({ nodeId: node.id, workgroupName, ...(workgroupId ? { workgroupId } : {}) })
  }
  return out
}

export interface ExecutionRefsOfDefinition {
  workflowNames: Set<string>
  workgroupNames: Set<string>
}

export function collectExecutionRefs(defn: WorkflowDefinition): ExecutionRefsOfDefinition {
  return {
    workflowNames: new Set(collectWorkflowCallRefs(defn).map((r) => r.workflowName)),
    workgroupNames: new Set(collectWorkgroupCallRefs(defn).map((r) => r.workgroupName)),
  }
}

export type ResolvedWorkflowRef =
  | { id: string; definition: WorkflowDefinition }
  | 'forbidden'
  | null

export interface CallCycleReport {
  /** Each cycle as an id path, first id repeated at the end (A→B→A). */
  cycles: string[][]
  /** Names that could not be resolved (missing or forbidden) — the walk
   *  cannot prove acyclicity through them; launch fails closed separately. */
  unresolved: string[]
}

/**
 * DFS three-color cycle detection over the call graph starting at `root`.
 * Deterministic: children visited in declaration order; each distinct cycle
 * is reported once (keyed by its id multiset entry point).
 *
 * RFC-271 T6e（决策 28）—— resolver 收的是**整条边**（`ref` + 它所在定义的
 * `sourceWorkflowId`），不再是裸名字。名字不是身份：同一张图里两个同名
 * selector 可以分别指向 W1/W2，按名解析必然走错一支 ⇒ **放过真实的环**
 * （根 R 有 c1→W1、c2→W2 且 W2→R，按名解析只看得见 W1 那支）。
 * 三色状态仍按**行 id** 记，因为图的顶点是工作流行而不是边。
 */
export function detectCallCycles(
  root: { id: string; definition: WorkflowDefinition },
  resolve: (ref: WorkflowCallRef, sourceWorkflowId: string) => ResolvedWorkflowRef,
): CallCycleReport {
  const cycles: string[][] = []
  const unresolved = new Set<string>()
  const state = new Map<string, 'gray' | 'black'>()
  const stack: string[] = []

  const visit = (id: string, definition: WorkflowDefinition): void => {
    state.set(id, 'gray')
    stack.push(id)
    for (const ref of collectWorkflowCallRefs(definition)) {
      const child = resolve(ref, id)
      if (child === null || child === 'forbidden') {
        unresolved.add(ref.workflowName)
        continue
      }
      const mark = state.get(child.id)
      if (mark === 'gray') {
        const start = stack.indexOf(child.id)
        cycles.push([...stack.slice(start), child.id])
        continue
      }
      if (mark === 'black') continue
      visit(child.id, child.definition)
    }
    stack.pop()
    state.set(id, 'black')
  }

  visit(root.id, root.definition)
  return { cycles, unresolved: [...unresolved] }
}
