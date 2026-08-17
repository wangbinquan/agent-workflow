// RFC-307 — reading the stage-graph response without assuming it arrived.
//
// This exists because the obvious check is wrong in a way that takes the page
// down. The endpoint answers with either a graph or `{reason: 'no-stage-contract'}`,
// so the tempting test is `'reason' in data ? … : data.nodes`. But the negative
// of "the server said there is no contract" is not "the server sent a graph" —
// it is "the server sent something else", and reading `.nodes` off that throws
// inside render.
//
// Both callers hit it (the Flow tab and the round overlay), which is why the
// check lives in one place rather than being written twice slightly differently.

import type { CapabilityGraphEdge, CapabilityGraphNode } from './CapabilityFlow'

export type CapabilityGraphResponse =
  | { capability: string; reason: 'no-stage-contract' }
  | {
      capability: string
      stageContractVer: number
      nodes: CapabilityGraphNode[]
      edges: CapabilityGraphEdge[]
    }

export type ReadGraph =
  /** Still loading, or a body in neither shape. Callers render nothing. */
  | { kind: 'none' }
  /** A real answer: this capability is not driven by a stage sequence. */
  | { kind: 'no-contract' }
  | {
      kind: 'graph'
      stageContractVer: number
      nodes: readonly CapabilityGraphNode[]
      edges: readonly CapabilityGraphEdge[]
    }

export function readGraph(data: unknown): ReadGraph {
  if (data === null || typeof data !== 'object') return { kind: 'none' }
  if ((data as { reason?: unknown }).reason === 'no-stage-contract') return { kind: 'no-contract' }
  const nodes = (data as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return { kind: 'none' }
  const edges = (data as { edges?: unknown }).edges
  const version = (data as { stageContractVer?: unknown }).stageContractVer
  return {
    kind: 'graph',
    // A graph that arrived without its version is still a usable picture; the
    // staleness notice just has nothing to compare against, which is better
    // than discarding the whole sequence over one missing number.
    stageContractVer: typeof version === 'number' ? version : 0,
    nodes: nodes as CapabilityGraphNode[],
    edges: Array.isArray(edges) ? (edges as CapabilityGraphEdge[]) : [],
  }
}
