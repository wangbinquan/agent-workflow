// RFC-306 — DB side of the branch-activation judgment.
//
// Turns "this node is about to be dispatched" into `active` or `skipped`, by
// resolving every inbound dataflow edge to a settled upstream row + port row and
// handing the result to the pure domain rule (domain/branchActivation.ts).
//
// The two hard requirements this file exists to honour:
//
//   1. It reads the SAME edge projection as `resolveUpstreamInputs`
//      (domain/inboundEdges.ts) and the SAME row picker as every other
//      read-point (`pickUpstreamSourceRun`, now settled = done ∪ skipped). A
//      judgment made against a different edge set or a different generation than
//      the one whose values get rendered into the prompt is worse than no
//      judgment at all.
//
//   2. It returns the `consumed` provenance map it resolved. The caller MUST
//      stamp that onto the skipped row: freshness is what makes a skip
//      reversible (RFC-306 D10). A skipped row without provenance is never
//      "fresh", so the frontier re-dispatches it every tick — a busy loop.

import { pickFrameSourceRun } from '@/services/freshness'
import { joinModeOf, resolveWorkflowSourceRef } from '@agent-workflow/shared'
import { resolveSourceFrame, type FrameCoordinate } from '../domain/environmentChain'
import { loadFrameChain } from './frameChain'
import type { PortRef, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  edgeActivationOf,
  resolveNodeActivation,
  type EdgeActivation,
  type NodeActivation,
} from '../domain/branchActivation'
import {
  collectDataflowInboundEdges,
  collectImplicitInboundRefs,
  nodeKindIndex,
} from '../domain/inboundEdges'
import type { NodeActivationSnapshotReader } from './ports/nodeActivationSnapshotReader'

export interface NodeActivationDecision {
  activation: NodeActivation
  /** upstream nodeId → node_run id actually consulted (provenance for the row). */
  consumed: Record<string, string>
  /** Per-edge detail, for the run trace and for diagnostics. */
  edges: Array<{
    sourceNodeId: string
    sourcePortName: string
    targetPortName: string
    activation: EdgeActivation
  }>
}

export async function resolveNodeActivationForDispatch(args: {
  reader: NodeActivationSnapshotReader
  taskId: string
  definition: WorkflowDefinition
  node: WorkflowNode
  /** RFC-354 — the frame the node is about to be dispatched in. */
  frame: FrameCoordinate
  parents?: ReadonlyMap<string, string>
  /** RFC-306 §10 — set when the operator pressed "run anyway" on this node. */
  forceActivated?: boolean
}): Promise<NodeActivationDecision> {
  const { reader, taskId, definition, node, frame } = args
  // RFC-354 — the judgment reads each source in the frame the environment
  // chain resolves it to, exactly like resolveUpstreamInputs will a moment
  // later (requirement 1 above).
  const chain = await loadFrameChain((id) => reader.findRun(id), frame)
  // Explicit dataflow edges + the implicit references the scheduler already
  // treats as dependencies (review.inputSource / output ports[].bind). Design
  // gate P1#2: judging activation on edges alone leaves review and output nodes
  // reading as edgeless roots, so a closed branch would still open a human
  // review and still produce a `done` output node.
  const incoming: Array<{ source: PortRef; targetPortName: string }> = [
    ...collectDataflowInboundEdges(definition.edges, node.id, nodeKindIndex(definition)).map(
      (e) => ({ source: e.source, targetPortName: e.target.portName }),
    ),
    ...collectImplicitInboundRefs(
      node as { kind: string; inputSource?: unknown; ports?: unknown },
    ).map((ref) => ({ source: ref, targetPortName: ref.portName })),
  ]

  const consumed: Record<string, string> = {}
  const edges: NodeActivationDecision['edges'] = []
  // One row read per distinct source node, not per edge: a node with three edges
  // from the same upstream must consult one generation, exactly like
  // resolveUpstreamInputs' `consumed` map does.
  const runByNode = new Map<string, { id: string; status: string } | undefined>()
  const portsByRun = new Map<string, Map<string, boolean>>()

  for (const edge of incoming) {
    const resolved = resolveWorkflowSourceRef(definition, edge.source, node.id, args.parents)
    // An unresolvable wrapper boundary is a definition error that
    // resolveUpstreamInputs raises loudly a moment later; here it must not be
    // read as "branch closed", so it degrades to `unresolved` (⇒ active).
    const source = resolved.ok ? resolved.source : edge.source

    if (!runByNode.has(source.nodeId)) {
      const rows = await reader.findRuns(taskId, source.nodeId)
      // A source the chain cannot see degrades to `unresolved` (⇒ active),
      // the same way an unresolvable wrapper boundary does above; the loud
      // failure belongs to resolveUpstreamInputs.
      const sourceFrame =
        args.parents === undefined
          ? { ok: true as const, frame }
          : resolveSourceFrame({
              sourceNodeId: source.nodeId,
              targetNodeId: node.id,
              parents: args.parents,
              frame,
              containerRowById: chain.lookup,
            })
      const picked = sourceFrame.ok ? pickFrameSourceRun(rows, sourceFrame.frame) : undefined
      runByNode.set(source.nodeId, picked)
      if (picked !== undefined) {
        consumed[source.nodeId] = picked.id
        portsByRun.set(picked.id, new Map(await reader.findOutputActivation(picked.id)))
      }
    }

    const run = runByNode.get(source.nodeId)
    const activation = edgeActivationOf({
      ...(run !== undefined ? { status: run.status } : {}),
      // Absent port row ⇒ leave `portActive` undefined ⇒ ACTIVE. That is the
      // backwards-compatibility hinge: a port the producer never emitted has no
      // row, and only an explicit marker may close a branch (RFC-306 §4.2).
      ...(run !== undefined && portsByRun.get(run.id)?.has(source.portName) === true
        ? { portActive: portsByRun.get(run.id)!.get(source.portName)! }
        : {}),
    })
    edges.push({
      sourceNodeId: source.nodeId,
      sourcePortName: source.portName,
      targetPortName: edge.targetPortName,
      activation,
    })
  }

  const activation = resolveNodeActivation({
    inbound: edges.map((e) => e.activation),
    joinMode: joinModeOf(node as { joinMode?: unknown }),
    ...(args.forceActivated === true ? { forceActivated: true } : {}),
  })
  return { activation, consumed, edges }
}
