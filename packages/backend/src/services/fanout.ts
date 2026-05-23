// RFC-060 PR-D — wrapper-fanout shard-scope inference + cross-set
// auto-promote (design §6.1-6.2).
//
// Pure functions only — no DB / no scheduler state. Scheduler dispatches
// per the returned scope.

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { findFanoutAggregator } from '@agent-workflow/shared'

export interface ShardScope {
  /** Inner nodes that run once per shard (N node_run rows minted). */
  perShard: Set<string>
  /** Inner nodes that run once (shared / broadcast inputs only). */
  shared: Set<string>
  /** The aggregator agent node id, if any. Always runs once and never
   *  participates in perShard / shared sets — it's a separate axis. */
  aggregatorId: string | null
  /** The shardSource input port name on the wrapper (for diagnostics). */
  shardSourceName: string | null
}

export interface ShardScopeInput {
  wrapperId: string
  defn: WorkflowDefinition
  /** Agents indexed by name; used to resolve aggregator inner nodes. */
  agents: ReadonlyMap<string, Agent> | Readonly<Record<string, Agent | undefined>>
}

function getInnerIds(defn: WorkflowDefinition, wrapperId: string): string[] {
  const node = defn.nodes.find((n) => n.id === wrapperId)
  if (node === undefined || node.kind !== 'wrapper-fanout') return []
  const rec = node as Record<string, unknown>
  return Array.isArray(rec.nodeIds)
    ? (rec.nodeIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
}

function getShardSourcePort(defn: WorkflowDefinition, wrapperId: string): string | null {
  const node = defn.nodes.find((n) => n.id === wrapperId)
  if (node === undefined || node.kind !== 'wrapper-fanout') return null
  const rec = node as Record<string, unknown>
  const inputs = Array.isArray(rec.inputs) ? (rec.inputs as unknown[]) : []
  for (const item of inputs) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (r.isShardSource === true && typeof r.name === 'string') return r.name
  }
  return null
}

/**
 * Compute the shard-scope split for the inner subgraph of a wrapper-fanout.
 * BFS starts from boundary edges leaving the shardSource port and follows
 * inner-to-inner edges. Aggregator agents are deliberately excluded from
 * the perShard set (they run once at convergence and receive raw lists).
 *
 * `applyAutoPromote` should be called on the returned scope to expand
 * perShard via cross-set fan-in propagation (design §6.2). The split is
 * separated into two passes so tests can exercise each independently.
 */
export function computeShardScope(input: ShardScopeInput): ShardScope {
  const { wrapperId, defn, agents } = input
  const innerIds = new Set(getInnerIds(defn, wrapperId))
  const aggregator = findFanoutAggregator(defn, wrapperId, agents)
  const aggregatorId = aggregator?.node.id ?? null
  const shardSourceName = getShardSourcePort(defn, wrapperId)

  const seeds: string[] = []
  if (shardSourceName !== null) {
    for (const e of defn.edges) {
      if (e.boundary !== 'wrapper-input') continue
      if (e.source.nodeId !== wrapperId) continue
      if (e.source.portName !== shardSourceName) continue
      if (!innerIds.has(e.target.nodeId)) continue
      if (e.target.nodeId === aggregatorId) continue
      seeds.push(e.target.nodeId)
    }
  }

  const perShard = new Set<string>()
  const queue = [...seeds]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (perShard.has(cur)) continue
    perShard.add(cur)
    for (const e of defn.edges) {
      if (e.source.nodeId !== cur) continue
      // Boundary-output edges leave the wrapper — stop propagation.
      if (e.boundary === 'wrapper-output') continue
      // Stay inside the wrapper's inner subgraph.
      if (!innerIds.has(e.target.nodeId)) continue
      // Aggregator is a fan-in terminal; it gets raw lists, not per-shard
      // membership.
      if (e.target.nodeId === aggregatorId) continue
      queue.push(e.target.nodeId)
    }
  }

  const shared = new Set<string>()
  for (const id of innerIds) {
    if (id === aggregatorId) continue
    if (perShard.has(id)) continue
    shared.add(id)
  }

  return { perShard, shared, aggregatorId, shardSourceName }
}

/**
 * Cross-set promote: when an edge goes from `perShard` source → `shared`
 * target (target != aggregator), the target becomes per-shard too. Runs
 * to a fixed point so chains promote transitively.
 *
 * Mutates the scope in place; returns the same object for chaining. The
 * aggregator is exempt (per design §6.2 — it always runs once and consumes
 * raw lists, never inherits per-shard cardinality).
 */
export function applyAutoPromote(scope: ShardScope, defn: WorkflowDefinition): ShardScope {
  const innerIds = new Set<string>([...scope.perShard, ...scope.shared])
  if (scope.aggregatorId !== null) innerIds.add(scope.aggregatorId)

  let changed = true
  while (changed) {
    changed = false
    for (const e of defn.edges) {
      if (e.boundary !== undefined) continue // skip wrapper boundary edges
      if (!innerIds.has(e.source.nodeId) || !innerIds.has(e.target.nodeId)) continue
      if (!scope.perShard.has(e.source.nodeId)) continue
      if (!scope.shared.has(e.target.nodeId)) continue
      if (e.target.nodeId === scope.aggregatorId) continue
      scope.shared.delete(e.target.nodeId)
      scope.perShard.add(e.target.nodeId)
      changed = true
    }
  }
  return scope
}

/**
 * Estimate the total shard count an outer wrapper-fanout will produce
 * by multiplying through nested wrapper-fanout `expectedShardCount`
 * hints (design §11.2). Used by the runtime cartesian guard (D.T6) in
 * `scheduler.ts` before minting per-shard node_runs.
 *
 * Inputs:
 *  - `outerShardCount`: actual number of items in the shardSource list
 *    at run time (the outer dimension).
 *  - `defn` + `wrapperId`: walk down the inner subgraph for any nested
 *    wrapper-fanout, multiplying their `expectedShardCount` (default 16
 *    when not declared).
 *
 * Doesn't recurse to runtime values of nested fanouts (those are unknown
 * before dispatch); uses the static hint as a conservative upper bound.
 */
export function estimateShardTotal(
  defn: WorkflowDefinition,
  wrapperId: string,
  outerShardCount: number,
  defaultExpectedShardCount: number = 16,
): number {
  const node = defn.nodes.find((n) => n.id === wrapperId)
  if (node === undefined || node.kind !== 'wrapper-fanout') return outerShardCount
  const innerIds = getInnerIds(defn, wrapperId)
  let nestedFactor = 1
  for (const innerId of innerIds) {
    const inner = defn.nodes.find((n) => n.id === innerId)
    if (inner === undefined || inner.kind !== 'wrapper-fanout') continue
    const declared = (inner as Record<string, unknown>).expectedShardCount
    nestedFactor *=
      typeof declared === 'number' && Number.isInteger(declared) && declared > 0
        ? declared
        : defaultExpectedShardCount
  }
  return outerShardCount * nestedFactor
}

/**
 * Identify boundary edges arriving at a specific inner node from a given
 * wrapper input port. Useful for the scheduler when injecting the
 * shard / broadcast value into the inner node's resolved inputs.
 */
export function findBoundaryEdgesToInner(
  defn: WorkflowDefinition,
  wrapperId: string,
  innerNodeId: string,
): WorkflowEdge[] {
  return defn.edges.filter(
    (e) =>
      e.boundary === 'wrapper-input' &&
      e.source.nodeId === wrapperId &&
      e.target.nodeId === innerNodeId,
  )
}
