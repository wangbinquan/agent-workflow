// RFC-109 — pure diff between a task's frozen `workflow_snapshot` and the latest
// workflow definition, powering the "sync latest workflow & continue" preview.
//
// Pure module: imports only TYPES from ./schemas/workflow (no zod runtime, no DB,
// no scheduler), so every classification below is trivially unit-testable. The
// caller (preview route / sync service) supplies `runSummary` — the per-node run
// facts that need DB access (was it completed, what ports did its preserved run
// actually produce, does a wrapper hold live parked/shard state).
//
// Semantics anchored to the scheduler (verified against source, see design §9):
//   - "preserve completed" is really "preserve done∧fresh" (RFC-074). A done
//     node only re-runs if a consumed upstream advanced; a NEW upstream edge
//     into a done node is silently ignored (its consumed map lacks it) — hence
//     the `new-upstream-into-completed-node` warning.
//   - a downstream input resolves to '' when the upstream's preserved run lacks
//     the (possibly renamed) source port — `port?.content ?? ''` — hence the
//     `dangling-input-port` warning based on ACTUAL produced ports, not the new
//     definition's declarations (those are already caught by the validator).
//   - parked wrapper progress / fanout shard rows are keyed to the OLD graph;
//     swapping a wrapper's structure under live rows corrupts resume — hence the
//     `wrapper-structure-changed-with-live-state` BLOCKER (not a warning).

import { isWrapperKind } from './schemas/workflow'
import { touchesSystemChannelPort } from './systemChannelPorts'
import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from './schemas/workflow'

// RFC-147: the private 5-port set moved to the shared system-channel-port
// registry (systemChannelPorts.ts). This diff view keeps its deliberately
// WIDE either-side match (`touchesSystemChannelPort`) — a channel port name
// on the wrong side of a corrupt edge must still be filtered out of the
// "data edge changed" rows.
function isChannelEdge(e: WorkflowEdge): boolean {
  return touchesSystemChannelPort(e)
}

export interface WorkflowSyncNodeChange {
  nodeId: string
  label: string
  kind: string
}

export interface WorkflowSyncModified extends WorkflowSyncNodeChange {
  /** True iff this node has a completed run that sync will preserve (D2). */
  completed: boolean
  /** Top-level node fields that changed (e.g. 'prompt', 'agent', 'overrides'). */
  changed: string[]
}

export type WorkflowSyncWarningCode =
  | 'removed-node-feeds-downstream'
  | 'dangling-input-port'
  | 'new-upstream-into-completed-node'

export interface WorkflowSyncWarning {
  code: WorkflowSyncWarningCode
  nodeId: string
  detail: string
}

export interface WorkflowSyncBlocker {
  code: 'wrapper-structure-changed-with-live-state'
  nodeId: string
  detail: string
}

export interface WorkflowSyncDiff {
  /** Semantic content (node fields minus canvas position) differs. */
  differs: boolean
  added: WorkflowSyncNodeChange[]
  removed: Array<WorkflowSyncNodeChange & { hadCompletedRun: boolean }>
  modified: WorkflowSyncModified[]
  warnings: WorkflowSyncWarning[]
  /** Non-empty ⇒ POST /sync-workflow must reject (preview disables "Sync"). */
  blockers: WorkflowSyncBlocker[]
}

export function emptyWorkflowSyncDiff(): WorkflowSyncDiff {
  return { differs: false, added: [], removed: [], modified: [], warnings: [], blockers: [] }
}

/**
 * RFC-109 — `GET /api/tasks/:id/workflow-sync-preview` response. Drives the
 * "workflow updated (vN→vM)" banner + the confirm dialog. `syncable` gates the
 * banner; when false, `reason` says why (and diff/version fields are zeroed).
 */
export interface WorkflowSyncPreview {
  /** Banner shows only when syncable && diff.differs. */
  syncable: boolean
  reason:
    | 'ok'
    | 'workflow-deleted'
    | 'workflow-not-visible'
    | 'builtin-workflow'
    | 'task-active'
    | 'worktree-missing'
  workflowId: string
  workflowName: string | null
  /** Version the task's snapshot was frozen/last-synced at; null for legacy. */
  currentVersion: number | null
  /** Live workflow version; null when the workflow was deleted. */
  latestVersion: number | null
  /** Semantic content differs (drives the banner alongside `syncable`). */
  differs: boolean
  /** The live definition currently fails static validation → sync is blocked. */
  invalid: boolean
  invalidIssues: { code: string; message: string }[]
  diff: WorkflowSyncDiff
}

/** Per-node run facts the caller resolves from the DB (by nodeId). */
export interface NodeRunSyncSummary {
  /** Any done top-level run exists for this node. */
  hasCompletedRun: boolean
  /** Output port names the node's freshest done run actually produced. */
  producedPorts: ReadonlySet<string>
  /** Wrapper holds parked progress (wrapper_progress_json) or child shard rows. */
  hasLiveWrapperState: boolean
}

function nodeLabel(n: WorkflowNode): string {
  const title = (n as { title?: unknown }).title
  return typeof title === 'string' && title.length > 0 ? title : n.id
}

function change(n: WorkflowNode): WorkflowSyncNodeChange {
  return { nodeId: n.id, label: nodeLabel(n), kind: n.kind }
}

/** Node minus purely-visual fields (canvas position), for semantic comparison. */
function semanticNode(n: WorkflowNode): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
    if (k === 'position') continue
    rest[k] = v
  }
  return rest
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

function nodesById(def: WorkflowDefinition): Map<string, WorkflowNode> {
  const m = new Map<string, WorkflowNode>()
  for (const n of def.nodes) m.set(n.id, n)
  return m
}

/** Top-level semantic keys whose stable JSON differs between two nodes. */
function changedKeys(a: WorkflowNode, b: WorkflowNode): string[] {
  const sa = semanticNode(a)
  const sb = semanticNode(b)
  const keys = new Set([...Object.keys(sa), ...Object.keys(sb)])
  const out: string[] = []
  for (const k of keys) {
    if (stableStringify(sa[k]) !== stableStringify(sb[k])) out.push(k)
  }
  return out.sort()
}

/**
 * Structural fingerprint of a wrapper (Codex impl-gate F1) — its node minus
 * purely-visual fields (position/title) PLUS every edge incident to it. This
 * catches the changes that invalidate a parked wrapper's resume but live OUTSIDE
 * the wrapper node object: boundary-edge rewiring (fanout), and — because the id
 * may be absent on one side — wrapper REMOVAL (node → null) and wrapper KIND
 * change. It also includes the INTERNAL edges among the wrapper's `nodeIds`
 * (Codex impl-gate re-review F1 follow-up) so inner-subgraph rewiring that
 * touches neither the wrapper node nor its incident edges is still caught.
 * Changing only an inner node's prompt leaves all three components untouched, so
 * the fingerprint is stable (killer use case stays unblocked); inner node-set
 * changes show up as a changed `nodeIds` field on the wrapper node itself.
 */
function edgeKey(e: WorkflowEdge): string {
  return `${e.source.nodeId}.${e.source.portName}->${e.target.nodeId}.${e.target.portName}|${e.boundary ?? ''}`
}
function wrapperFingerprint(
  def: WorkflowDefinition,
  id: string,
  node: WorkflowNode | undefined,
): string {
  let structural: Record<string, unknown> | null = null
  const memberIds = new Set<string>()
  if (node !== undefined) {
    structural = semanticNode(node)
    delete structural.title
    const ids = (node as { nodeIds?: unknown }).nodeIds
    if (Array.isArray(ids)) for (const m of ids) if (typeof m === 'string') memberIds.add(m)
  }
  const incident = def.edges
    .filter((e) => e.source.nodeId === id || e.target.nodeId === id)
    .map(edgeKey)
    .sort()
  const internal = def.edges
    .filter((e) => memberIds.has(e.source.nodeId) && memberIds.has(e.target.nodeId))
    .map(edgeKey)
    .sort()
  return stableStringify({ node: structural, incident, internal })
}

/** Definition canonicalized for the `differs` check: node positions stripped so
 *  a canvas-only move does not register as a meaningful change. */
function canonicalDef(def: WorkflowDefinition): string {
  return stableStringify({
    nodes: def.nodes.map(semanticNode),
    edges: def.edges,
    outputs: (def as { outputs?: unknown }).outputs ?? null,
  })
}

/** Set of `${source.nodeId}->${target.nodeId}` for non-channel data edges. */
function dataEdgePairs(def: WorkflowDefinition): Set<string> {
  const s = new Set<string>()
  for (const e of def.edges) {
    if (isChannelEdge(e)) continue
    s.add(`${e.source.nodeId}->${e.target.nodeId}`)
  }
  return s
}

export function diffWorkflowForSync(
  oldDef: WorkflowDefinition,
  newDef: WorkflowDefinition,
  runSummary: ReadonlyMap<string, NodeRunSyncSummary>,
): WorkflowSyncDiff {
  const oldNodes = nodesById(oldDef)
  const newNodes = nodesById(newDef)

  const added: WorkflowSyncNodeChange[] = []
  const removed: Array<WorkflowSyncNodeChange & { hadCompletedRun: boolean }> = []
  const modified: WorkflowSyncModified[] = []

  for (const [id, n] of newNodes) {
    if (!oldNodes.has(id)) {
      added.push(change(n))
      continue
    }
    const old = oldNodes.get(id)!
    const ck = changedKeys(old, n)
    if (ck.length > 0) {
      modified.push({
        ...change(n),
        completed: runSummary.get(id)?.hasCompletedRun ?? false,
        changed: ck,
      })
    }
  }
  for (const [id, n] of oldNodes) {
    if (!newNodes.has(id)) {
      removed.push({ ...change(n), hadCompletedRun: runSummary.get(id)?.hasCompletedRun ?? false })
    }
  }

  const warnings: WorkflowSyncWarning[] = []
  const blockers: WorkflowSyncBlocker[] = []

  // removed-node-feeds-downstream: a deleted node that produced output, whose
  // output still fed a node that survives in the new graph (downstream loses it).
  for (const r of removed) {
    if (!r.hadCompletedRun) continue
    for (const e of oldDef.edges) {
      if (isChannelEdge(e)) continue
      if (e.source.nodeId !== r.nodeId) continue
      if (!newNodes.has(e.target.nodeId)) continue
      warnings.push({
        code: 'removed-node-feeds-downstream',
        nodeId: r.nodeId,
        detail: `removed node "${r.label}" fed "${nodeLabel(newNodes.get(e.target.nodeId)!)}"; that input is now gone`,
      })
      break
    }
  }

  const oldPairs = dataEdgePairs(oldDef)
  for (const e of newDef.edges) {
    if (isChannelEdge(e)) continue
    const src = newNodes.get(e.source.nodeId)
    const tgt = newNodes.get(e.target.nodeId)
    if (src === undefined || tgt === undefined) continue
    const srcSummary = runSummary.get(e.source.nodeId)
    const tgtSummary = runSummary.get(e.target.nodeId)
    const tgtCompleted = tgtSummary?.hasCompletedRun ?? false
    const srcCompleted = srcSummary?.hasCompletedRun ?? false

    // dangling-input-port: a node that WILL run reads a port the preserved
    // upstream run never produced (port rename / shape change) → empty input.
    if (!tgtCompleted && srcCompleted) {
      if (!(srcSummary?.producedPorts.has(e.source.portName) ?? false)) {
        warnings.push({
          code: 'dangling-input-port',
          nodeId: e.target.nodeId,
          detail: `"${nodeLabel(tgt)}" reads port "${e.source.portName}" from "${nodeLabel(src)}", whose preserved run did not produce it; the input will be empty`,
        })
      }
    }

    // new-upstream-into-completed-node: a new edge feeds an already-completed
    // node; its preserved run won't incorporate the new upstream (RFC-074).
    if (tgtCompleted && !oldPairs.has(`${e.source.nodeId}->${e.target.nodeId}`)) {
      warnings.push({
        code: 'new-upstream-into-completed-node',
        nodeId: e.target.nodeId,
        detail: `new upstream "${nodeLabel(src)}" → completed "${nodeLabel(tgt)}"; the preserved output will not include it (retry the node to re-run)`,
      })
    }
  }

  // wrapper-structure-changed-with-live-state (BLOCKER, Codex impl-gate F1): a
  // wrapper that holds live parked/shard state whose STRUCTURE changed across the
  // sync. Iterates the union of old+new wrapper ids (so REMOVAL and KIND change
  // are caught, not just in-place edits) and compares the structural fingerprint
  // (node fields incl. nodeIds/maxIterations/exit/sourcePort + incident boundary
  // edges). Changing only an inner node's prompt leaves the fingerprint stable —
  // the killer use case stays unblocked.
  const wrapperIds = new Set<string>()
  for (const n of oldDef.nodes) if (isWrapperKind(n.kind)) wrapperIds.add(n.id)
  for (const n of newDef.nodes) if (isWrapperKind(n.kind)) wrapperIds.add(n.id)
  for (const id of wrapperIds) {
    if (!(runSummary.get(id)?.hasLiveWrapperState ?? false)) continue
    if (
      wrapperFingerprint(oldDef, id, oldNodes.get(id)) !==
      wrapperFingerprint(newDef, id, newNodes.get(id))
    ) {
      const label = nodeLabel(newNodes.get(id) ?? oldNodes.get(id)!)
      blockers.push({
        code: 'wrapper-structure-changed-with-live-state',
        nodeId: id,
        detail: `wrapper "${label}" changed structure while it holds in-progress state; sync would corrupt its resume — start a new task instead`,
      })
    }
  }

  return {
    differs: canonicalDef(oldDef) !== canonicalDef(newDef),
    added,
    removed,
    modified,
    warnings,
    blockers,
  }
}
