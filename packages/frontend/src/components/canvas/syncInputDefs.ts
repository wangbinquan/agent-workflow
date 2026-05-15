// RFC-004: Reconcile `definition.inputs[]` with the set of input nodes by
// inputKey. The editor calls this after every node add / patch / delete so the
// 1-second auto-save flow writes the corrected shape back to the daemon.
//
// Rules (order matters):
//   1. Keep every existing inputs[] entry whose key is referenced by some
//      input node — preserves user-customized label / kind / required /
//      description across edits.
//   2. For every input node whose inputKey has no matching entry, append a
//      default entry `{ kind: 'text', key, label: key, required: true }`.
//   3. Drop inputs[] entries whose key is no longer referenced (validator
//      surfaces orphans as warnings; the editor canonicalizes the shape
//      eagerly so warnings don't pile up after delete-node operations).
//
// Pure: returns the previous array reference when no change is needed so
// React state updates can short-circuit.

import type { WorkflowDefinition, WorkflowInput, WorkflowNode } from '@agent-workflow/shared'

export function syncInputDefs(prevInputs: WorkflowInput[], nodes: WorkflowNode[]): WorkflowInput[] {
  const keysInNodes = new Set<string>()
  for (const n of nodes) {
    if (n.kind !== 'input') continue
    const k = (n as Record<string, unknown>).inputKey
    if (typeof k === 'string' && k.length > 0) keysInNodes.add(k)
  }

  const kept = prevInputs.filter((i) => keysInNodes.has(i.key))
  const keptKeys = new Set(kept.map((i) => i.key))
  const added: WorkflowInput[] = []
  for (const k of keysInNodes) {
    if (keptKeys.has(k)) continue
    added.push({ kind: 'text', key: k, label: k, required: true })
  }

  if (added.length === 0 && kept.length === prevInputs.length) {
    return prevInputs
  }
  return [...kept, ...added]
}

/**
 * Rename an input node's inputKey end-to-end: the node's own field, the
 * matching `definition.inputs[]` entry's key, AND every outbound edge whose
 * source.portName == prevKey. The agent-side `target.portName` is NOT
 * rewritten — users wire those names explicitly in the inspector and
 * shouldn't be retroactively renamed.
 *
 * Returns `prevDef` unchanged if no rename is needed (sameKey / not-an-input /
 * unknown node). Otherwise returns a new definition with the three coordinated
 * mutations applied.
 */
export function renameInputKey(
  prevDef: WorkflowDefinition,
  nodeId: string,
  nextKey: string,
): WorkflowDefinition {
  if (nextKey.length === 0) return prevDef
  const node = prevDef.nodes.find((n) => n.id === nodeId)
  if (node === undefined || node.kind !== 'input') return prevDef
  const prevKey = (node as Record<string, unknown>).inputKey
  if (typeof prevKey !== 'string' || prevKey === nextKey) return prevDef

  const nodes = prevDef.nodes.map((n) =>
    n.id === nodeId
      ? ({ ...(n as Record<string, unknown>), inputKey: nextKey } as unknown as WorkflowNode)
      : n,
  )
  const inputs = (prevDef.inputs ?? []).map((i) => (i.key === prevKey ? { ...i, key: nextKey } : i))
  const edges = prevDef.edges.map((e) =>
    e.source.nodeId === nodeId && e.source.portName === prevKey
      ? { ...e, source: { ...e.source, portName: nextKey } }
      : e,
  )
  return { ...prevDef, nodes, inputs, edges }
}

/**
 * Patch one entry in `definition.inputs[]` by key. Used by the NodeInspector
 * to edit launcher-field metadata (label / kind / required / description)
 * without touching the input node. Returns prevDef unchanged when the key is
 * not present (which is impossible after a syncInputDefs pass).
 */
export function patchInputDef(
  prevDef: WorkflowDefinition,
  key: string,
  patch: Partial<WorkflowInput>,
): WorkflowDefinition {
  const prevInputs = prevDef.inputs ?? []
  let touched = false
  const inputs = prevInputs.map((i) => {
    if (i.key !== key) return i
    touched = true
    return { ...i, ...patch }
  })
  if (!touched) return prevDef
  return { ...prevDef, inputs }
}
