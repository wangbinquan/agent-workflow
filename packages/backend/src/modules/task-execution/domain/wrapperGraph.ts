import {
  buildWorkflowScopeParentMap,
  channelEdgeDataflowSkip,
  resolveWorkflowSourceRef,
} from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { directNodeIdsOf } from './executionScope'

// RFC-409 — the wrapper containment graph read off a workflow definition (no rows, no DB): moved
// verbatim from services/dispatchFrontier.ts. The frontier rules (engine/scope/frontierRules.ts), the
// wrapper run lifecycle and the run-liveness report (via public/queries) share it.

/** Safe read of a wrapper node's inner `nodeIds` (absent / non-array → []). */
function innerNodeIdsOf(node: WorkflowNode | undefined): readonly string[] {
  // RFC-409: inside task-execution, wrapper membership is read through the scope index's one reader
  // (RFC-339 lock); same array guard and string filter as before.
  return node === undefined
    ? []
    : directNodeIdsOf(node as unknown as { readonly nodeIds?: unknown })
}

/**
 * All transitive inner-descendant node ids of a wrapper (direct inner +
 * recursively the inner of any nested wrapper). Cycle-safe via `visiting`
 * (definitions are acyclic containment trees, but guard defensively). G6.
 */
export function wrapperInnerDescendants(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
  acc: Set<string> = new Set(),
  visiting: Set<string> = new Set(),
): Set<string> {
  if (visiting.has(wrapperNodeId)) return acc
  visiting.add(wrapperNodeId)
  const node = definition.nodes.find((n) => n.id === wrapperNodeId)
  for (const id of innerNodeIdsOf(node)) {
    acc.add(id)
    wrapperInnerDescendants(id, definition, acc, visiting)
  }
  return acc
}

/**
 * RFC-098 B3 (audit S-7) — the EXTERNAL upstream source set of a loop/git
 * wrapper: every node OUTSIDE the wrapper that feeds data into the wrapper's
 * inner scope (or into the wrapper row itself). This is the key set
 * the task-execution wrapper ledger stamps onto the wrapper's
 * `consumed_upstream_runs_json` at fresh-mint, so an upstream rerun (clarify
 * answer, review iterate, …) demotes the wrapper's done row to stale and the
 * frontier re-dispatches it — the same provenance contract wrapper-fanout has
 * carried since RFC-074 §8 D3.
 *
 * Membership = edges `external → (inner descendant ∪ wrapper itself)`:
 *   - inner descendants because v1 loop/git wrappers accept NO inbound edges
 *     (workflow.validator.ts 'does not accept inbound edges in v1') — external
 *     data enters via direct external→inner edges that resolveUpstreamInputs
 *     reads with the full definition.edges;
 *   - the wrapper itself to cover wrapper→wrapper ordering edges (the
 *     validator rejects them but the scheduler honors them — see
 *     scheduler-audit-s04's wg1→wg2 sequencing edge).
 *
 * Edge filtering is the SAME registry projection dagGraph.buildScopeUpstreams
 * uses — `channelEdgeDataflowSkip` (RFC-147), including the
 * carve-out that `questioner.__clarify__ → clarify-cross-agent` is a REAL
 * dataflow dep (kept) — plus review/output implicit dependencies.
 *
 * Pure function — definition-only, no DB / rows.
 */
export function wrapperExternalUpstreamSources(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
): Set<string> {
  const scope = wrapperInnerDescendants(wrapperNodeId, definition)
  scope.add(wrapperNodeId)
  const parents = buildWorkflowScopeParentMap(definition)
  const sources = new Set<string>()
  for (const e of definition.edges) {
    if (!scope.has(e.target.nodeId)) continue
    if (scope.has(e.source.nodeId)) continue
    // RFC-147: same shared registry projection buildScopeUpstreams uses —
    // the historical hand-copied block (whose comment demanded "keep the
    // two in lockstep") is gone; lockstep is now structural.
    if (channelEdgeDataflowSkip(e)) continue
    const resolved = resolveWorkflowSourceRef(definition, e.source, e.target.nodeId, parents)
    sources.add(resolved.ok ? resolved.source.nodeId : e.source.nodeId)
  }
  // RFC-354 (schema v6): review / output dependencies are ordinary edges, so the
  // edge walk above already covers them (the implicit `inputSource` /
  // `ports[].bind` mirror of buildScopeUpstreams retired with those fields).
  return sources
}
