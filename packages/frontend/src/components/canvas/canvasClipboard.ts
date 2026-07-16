// In-memory clipboard for workflow-canvas subgraphs.
//
// RFC-199: a clipboard slice is a self-contained semantic payload, not just
// visual nodes. Wrapper ownership is expanded recursively, every copied node
// reference is rewritten through the shared descriptor inventory, and input
// declarations travel with their input nodes so paste can never silently
// downgrade an upload/files/etc. launcher field to a default text input.

import {
  collectNodeReferenceClosure,
  rewriteCopiedWorkflowSlice,
  rewriteWorkflowPortReferences,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowNodeReferenceWarning,
  type WorkflowPortRename,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { effectiveWorkflowNodePosition } from '../../lib/workflow-placement'

export interface ClipboardSlice {
  /** Stable identity of the workflow the slice was copied from. */
  sourceWorkflowId: string
  nodes: WorkflowNode[]
  /** Edges entirely inside the recursively-expanded slice. */
  edges: WorkflowEdge[]
  /** Exactly one complete declaration for every distinct copied inputKey. */
  inputDeclarations: WorkflowInput[]
  /** Non-fatal legacy references filtered while expanding the slice. */
  warnings: WorkflowNodeReferenceWarning[]
  /** Position used as the anchor — paste offsets from this point. */
  anchor: { x: number; y: number }
}

export interface ClipboardPasteResult {
  definition: WorkflowDefinition
  newNodeIds: string[]
  warnings: WorkflowNodeReferenceWarning[]
}

export type ClipboardInvariantCode =
  | 'source-workflow-missing'
  | 'input-key-missing'
  | 'input-declaration-missing'
  | 'input-declaration-duplicate'
  | 'input-declaration-extra'
  | 'wrapper-membership-cycle'
  | 'node-reference-rewrite-unsafe'
  | 'port-reference-rewrite-unsafe'

/**
 * A fail-closed clipboard invariant. Callers must leave the definition and
 * selection untouched and surface a warning; no partial paste is returned.
 */
export class ClipboardInvariantError extends Error {
  readonly code: ClipboardInvariantCode
  readonly inputKey?: string

  constructor(code: ClipboardInvariantCode, message: string, inputKey?: string) {
    super(message)
    this.name = 'ClipboardInvariantError'
    this.code = code
    this.inputKey = inputKey
  }
}

let buffer: ClipboardSlice | null = null

/** Replace the clipboard. Pass `null` to clear. */
export function setClipboard(slice: ClipboardSlice | null): void {
  buffer = slice
}

export function getClipboard(): ClipboardSlice | null {
  return buffer
}

/**
 * Build a semantic clipboard slice from selected root nodes. Selecting a
 * wrapper includes its full recursive child closure; only edges whose two
 * endpoints are in that closure are copied.
 */
export function buildSlice(
  def: WorkflowDefinition,
  selectedNodeIds: Iterable<string>,
  sourceWorkflowId: string,
): ClipboardSlice | null {
  if (sourceWorkflowId.trim().length === 0) {
    throw new ClipboardInvariantError(
      'source-workflow-missing',
      'The clipboard source workflow id is required.',
    )
  }

  const closure = collectNodeReferenceClosure(def, selectedNodeIds)
  if (closure.warnings.some((warning) => warning.code === 'wrapper-membership-cycle')) {
    throw new ClipboardInvariantError(
      'wrapper-membership-cycle',
      'A wrapper membership cycle cannot be copied safely.',
    )
  }
  const ids = new Set(closure.nodeIds)
  const nodes = def.nodes.filter((node) => ids.has(node.id))
  if (nodes.length === 0) return null

  const edges = def.edges.filter(
    (edge) => ids.has(edge.source.nodeId) && ids.has(edge.target.nodeId),
  )
  const inputKeys = collectInputKeys(nodes)
  const inputDeclarations = declarationsForKeys(def.inputs ?? [], inputKeys)
  const effectivePositions = new Map(
    def.nodes.map((node, index) => [node.id, effectiveWorkflowNodePosition(node, index)] as const),
  )

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    const position = effectivePositions.get(node.id)
    if (position === undefined) continue
    if (position.x < minX) minX = position.x
    if (position.y < minY) minY = position.y
  }

  return {
    sourceWorkflowId,
    nodes: nodes.map((node) => ({
      ...structuredClone(node),
      position: effectivePositions.get(node.id) ?? effectiveWorkflowNodePosition(node, 0),
    })),
    edges: edges.map((edge) => structuredClone(edge)),
    inputDeclarations: inputDeclarations.map((input) => structuredClone(input)),
    warnings: closure.warnings.map((warning) => structuredClone(warning)),
    anchor: {
      x: Number.isFinite(minX) ? minX : 0,
      y: Number.isFinite(minY) ? minY : 0,
    },
  }
}

/**
 * Paste a complete slice at `at` in canonical canvas coordinates. The whole
 * operation is preflighted and constructed off to the side; an unsafe or
 * malformed payload throws before the target definition can change.
 */
export function applyPaste(
  def: WorkflowDefinition,
  slice: ClipboardSlice,
  at: { x: number; y: number },
): ClipboardPasteResult {
  if (slice.sourceWorkflowId.trim().length === 0) {
    throw new ClipboardInvariantError(
      'source-workflow-missing',
      'The clipboard source workflow id is required.',
    )
  }

  const sourceInputKeys = collectInputKeys(slice.nodes)
  assertSliceDeclarations(slice.inputDeclarations, sourceInputKeys)

  const existingNodeIds = new Set(def.nodes.map((node) => node.id))
  const idMap = new Map<string, string>()
  for (const node of slice.nodes) {
    idMap.set(node.id, uniqueNodeId(node.id, existingNodeIds, idMap))
  }

  const rewritten = rewriteCopiedWorkflowSlice({ nodes: slice.nodes, edges: slice.edges }, idMap)
  if (!rewritten.safe) {
    throw new ClipboardInvariantError(
      'node-reference-rewrite-unsafe',
      'The copied nodes contain an unsupported node reference field.',
    )
  }

  const inputKeyMap = buildInputKeyMap(def, sourceInputKeys)
  const mappedDeclarations = slice.inputDeclarations.map((input) => ({
    ...structuredClone(input),
    key: inputKeyMap.get(input.key) ?? input.key,
  }))

  const dx = at.x - slice.anchor.x
  const dy = at.y - slice.anchor.y
  const portRenames: WorkflowPortRename[] = []
  const mappedNodes = rewritten.nodes.map((node, index) => {
    const mapped = structuredClone(node)
    const position = effectiveWorkflowNodePosition(node, index)
    mapped.position = {
      x: Math.round(position.x + dx),
      y: Math.round(position.y + dy),
    }
    if (mapped.kind === 'input') {
      const record = mapped as WorkflowNode & { inputKey?: unknown }
      const sourceKey = requireInputKey(record)
      const targetKey = inputKeyMap.get(sourceKey)
      if (targetKey === undefined) {
        throw new ClipboardInvariantError(
          'input-declaration-missing',
          `No mapped declaration exists for input key "${sourceKey}".`,
          sourceKey,
        )
      }
      record.inputKey = targetKey
      if (sourceKey !== targetKey) {
        portRenames.push({
          nodeId: mapped.id,
          fromPortName: sourceKey,
          toPortName: targetKey,
        })
      }
    }
    return mapped
  })

  const existingEdgeIds = new Set(def.edges.map((edge) => edge.id))
  const mappedEdges = rewritten.edges.map((edge) => {
    const mapped = structuredClone(edge)
    mapped.id = uniqueEdgeId(existingEdgeIds)
    existingEdgeIds.add(mapped.id)
    return mapped
  })

  // Apply input-port renames to the isolated pasted subgraph. Because freshly
  // minted node ids cannot exist in `def`, no target-workflow reference can be
  // captured accidentally.
  const pastedDefinition: WorkflowDefinition = {
    $schema_version: def.$schema_version,
    inputs: mappedDeclarations,
    nodes: mappedNodes,
    edges: mappedEdges,
  }
  const portRewrite = rewriteWorkflowPortReferences(pastedDefinition, portRenames)
  if (!portRewrite.safe) {
    throw new ClipboardInvariantError(
      'port-reference-rewrite-unsafe',
      'The copied nodes contain an unsupported port reference field.',
    )
  }

  return {
    definition: {
      ...def,
      inputs: [...(def.inputs ?? []), ...portRewrite.definition.inputs],
      nodes: [...def.nodes, ...portRewrite.definition.nodes],
      edges: [...def.edges, ...portRewrite.definition.edges],
    },
    newNodeIds: portRewrite.definition.nodes.map((node) => node.id),
    warnings: [
      ...slice.warnings.map((warning) => structuredClone(warning)),
      ...rewritten.warnings,
      ...portRewrite.warnings,
    ],
  }
}

function collectInputKeys(nodes: readonly WorkflowNode[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node.kind !== 'input') continue
    const key = requireInputKey(node)
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

function requireInputKey(node: WorkflowNode): string {
  const raw = (node as WorkflowNode & { inputKey?: unknown }).inputKey
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ClipboardInvariantError(
      'input-key-missing',
      `Input node "${node.id}" has no usable inputKey.`,
    )
  }
  return raw
}

function declarationsForKeys(
  inputs: readonly WorkflowInput[],
  inputKeys: readonly string[],
): WorkflowInput[] {
  return inputKeys.map((key) => {
    const matches = inputs.filter((input) => input.key === key)
    if (matches.length === 0) {
      throw new ClipboardInvariantError(
        'input-declaration-missing',
        `Input declaration "${key}" is missing.`,
        key,
      )
    }
    if (matches.length > 1) {
      throw new ClipboardInvariantError(
        'input-declaration-duplicate',
        `Input declaration "${key}" is duplicated.`,
        key,
      )
    }
    return matches[0]!
  })
}

function assertSliceDeclarations(
  inputs: readonly WorkflowInput[],
  inputKeys: readonly string[],
): void {
  declarationsForKeys(inputs, inputKeys)
  const expected = new Set(inputKeys)
  const extra = inputs.find((input) => !expected.has(input.key))
  if (extra !== undefined) {
    throw new ClipboardInvariantError(
      'input-declaration-extra',
      `Clipboard declaration "${extra.key}" has no copied input node.`,
      extra.key,
    )
  }
}

function buildInputKeyMap(
  def: WorkflowDefinition,
  sourceInputKeys: readonly string[],
): Map<string, string> {
  const taken = new Set((def.inputs ?? []).map((input) => input.key))
  for (const node of def.nodes) {
    if (node.kind !== 'input') continue
    taken.add(requireInputKey(node))
  }

  const result = new Map<string, string>()
  for (const sourceKey of sourceInputKeys) {
    let targetKey = sourceKey
    if (taken.has(targetKey)) {
      targetKey = `${sourceKey}_copy`
      let suffix = 2
      while (taken.has(targetKey)) targetKey = `${sourceKey}_copy_${suffix++}`
    }
    taken.add(targetKey)
    result.set(sourceKey, targetKey)
  }
  return result
}

function uniqueNodeId(
  base: string,
  existing: ReadonlySet<string>,
  rewrites: ReadonlyMap<string, string>,
): string {
  const minted = new Set(rewrites.values())
  let candidate = `${base}_copy`
  let suffix = 2
  while (existing.has(candidate) || minted.has(candidate)) {
    candidate = `${base}_copy_${suffix++}`
  }
  return candidate
}

function uniqueEdgeId(existing: ReadonlySet<string>): string {
  const base = `edge_${ulid().slice(-6).toLowerCase()}`
  if (!existing.has(base)) return base
  let suffix = 2
  while (existing.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

// Test helpers.
export const __testApplyPaste = applyPaste
export const __testBuildSlice = buildSlice
export const __testReset = (): void => {
  buffer = null
}
