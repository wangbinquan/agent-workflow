import type { WorkflowNode, WorkflowDefinition } from '@agent-workflow/shared'
import type { NodeStepOutcome } from '../domain/nodeExecution'
import { collectDataflowInboundEdges } from '../domain/inboundEdges'
import { nodeOutputSlot } from '../domain/runSelection/nodeOutputSlot'
import { resolveNodeActivationForDispatch } from './resolveNodeActivation'
import type {
  NodeExecutionPersistence,
  NodeExecutionSnapshot,
} from './ports/nodeExecutionPersistence'
import type { NodeActivationSnapshotReader } from './ports/nodeActivationSnapshotReader'
import type { NodeRunLedger, NodeRunIdentityFactory, Logger } from './ports/executionKernel'
import type { NodeStatusEvents } from './ports/nodeExecutionSupport'

export interface SkippedRunPorts {
  readonly taskId: string
  readonly ledger: Pick<NodeRunLedger, 'mintNodeRun' | 'transitionNodeRunStatus'> &
    NodeRunIdentityFactory
  patch(
    input: Omit<Parameters<NodeExecutionPersistence['patch']>[0], 'executionContext'>,
  ): ReturnType<NodeExecutionPersistence['patch']>
  readonly status: NodeStatusEvents
}
export interface NodeBranchActivationPorts extends SkippedRunPorts {
  readonly definition: WorkflowDefinition
  readonly containerOf: ReadonlyMap<string, string>
  readonly log: Logger
  readonly rows: Pick<NodeExecutionPersistence, 'snapshotRead'>
  readonly activation: NodeActivationSnapshotReader
  prepareConsumedInputs(record: Record<string, string>): string
}

// -----------------------------------------------------------------------------
// RFC-306 — branch judgment + skip row (design §6.2)
// -----------------------------------------------------------------------------

/**
 * Decide whether `node` runs this iteration. Returns `null` to proceed with the
 * ordinary dispatch, or a settled outcome when the node was skipped.
 *
 * Three details are load-bearing:
 *
 *  1. **Provenance.** The skipped row stores the same `consumed_upstream_runs_json`
 *     an executed row would. That is what lets `isNodeRunFresh` mark the skip
 *     stale once an upstream re-runs, so retrying the deciding node re-opens the
 *     branch (D10 / AC-10). Without it the frontier would re-dispatch the node on
 *     every tick forever — the skip would look like it is "flapping".
 *
 *  2. **Mint pending → mark-skipped**, not a direct `skipped` mint: `skipped` is
 *     not in MintableNodeRunStatus, and the lifecycle table already owns the
 *     `pending → skipped` edge. A crash between the two writes leaves a pending
 *     row, which the orphan reaper flips to `interrupted` and the next pass
 *     re-judges — self-healing, no wedged state.
 *
 *  3. **`force_activated` is read from the LATEST row at this (node, iteration)**
 *     — retryNode stamps it on the placeholder it mints, and this is the read
 *     that turns "run anyway" into an actual run (§10).
 */
export async function judgeBranchActivation(
  ports: NodeBranchActivationPorts,
  node: WorkflowNode,
  iteration: number,
  /** RFC-354 — the frame the node is dispatched in; the skipped row lives there. */
  containerRunId: string | null,
): Promise<NodeStepOutcome | null> {
  const { taskId, definition, log } = ports
  // Fast path: a node with NO inbound dependency at all can never be branched
  // away (graph roots included), so a workflow that uses no branch ports pays
  // zero extra queries per dispatch — "existing behavior is unchanged" has to
  // hold for cost as well as for outcome. RFC-354 (schema v6): review / output
  // dependencies are ordinary edges now, so edges are the whole test.
  const hasInbound = collectDataflowInboundEdges(definition.edges, node.id).length > 0
  if (!hasInbound) return null
  const latest = await ports.rows.snapshotRead(async (snapshot) => {
    const existing = await snapshot.list({ taskId, nodeId: node.id, containerRunId, iteration })
    const selected = await snapshot.selection.current(
      taskId,
      nodeOutputSlot(node.id, node.kind, { containerRunId, iteration }),
    )
    return existing.find((row) => row.id === selected?.id)
  })
  const forceActivated = latest?.forceActivated === true

  const decision = await resolveNodeActivationForDispatch({
    reader: ports.activation,
    taskId,
    definition,
    node,
    frame: { containerRunId, iteration },
    parents: ports.containerOf,
    ...(forceActivated ? { forceActivated: true } : {}),
  })
  if (decision.activation.kind === 'active') return null

  const consumedJson = ports.prepareConsumedInputs(decision.consumed)
  // Design-gate P1#8 — a skip must SETTLE the node's current anchor, not park a
  // terminal sibling next to it. Two anchors matter:
  //
  //   pending      — minted out of band by a clarify answer / review iterate.
  //                  Leaving it behind means the row resolver later reuses it and
  //                  runs the node against the very branch decision that closed
  //                  it, and (because that row is OLDER than the skip row) the
  //                  skip stays "latest" and the scope can stall. Reuse it.
  //   awaiting_*   — a parked human gate. Leaving it behind keeps an actionable
  //                  item in the review inbox for a branch nobody will run.
  //                  Supersede it, then record the skip.
  //
  // Anything else (done / failed / interrupted / canceled / absent) is a settled
  // generation; the skip is a NEW generation on top of it, so it mints normally.
  await recordSkippedRun(ports, {
    node,
    containerRunId,
    iteration,
    latest,
    reason: decision.activation.reason,
    consumedJson,
  })
  log.info('node skipped — inbound branch inactive', {
    nodeId: node.id,
    iteration,
    reason: decision.activation.reason,
    inactiveFrom: decision.edges
      .filter((e) => e.activation.kind === 'inactive')
      .map((e) => `${e.sourceNodeId}.${e.sourcePortName}`),
  })
  return { kind: 'ok', summary: '', message: 'branch-skipped' }
}

/**
 * Settle a node as `skipped` in its frame (RFC-306 branch skip, RFC-354 D7
 * idle clarify gate). A pending anchor minted out of band is reused (it would
 * otherwise stay "latest" and re-run against the very decision that closed
 * it); a parked human gate is superseded first; anything settled is history
 * and the skip mints a new generation on top of it.
 */
export async function recordSkippedRun(
  ports: SkippedRunPorts,
  input: {
    readonly node: WorkflowNode
    readonly containerRunId: string | null
    readonly iteration: number
    readonly latest: NodeExecutionSnapshot | undefined
    readonly reason: string
    readonly consumedJson: string
  },
): Promise<string> {
  const { taskId } = ports
  const { node, containerRunId, iteration, latest, reason, consumedJson } = input
  let nodeRunId: string
  if (latest?.status === 'pending') {
    nodeRunId = latest.id
    await ports.patch({
      nodeRunId,
      values: {
        inputs: {
          consumedUpstreamRunsJson: consumedJson,
        },
      },
    })
    await ports.ledger.transitionNodeRunStatus({
      nodeRunId,
      event: { kind: 'mark-skipped', reason },
      extra: {
        identity: {
          finishedAt: Date.now(),
        },
      },
    })
  } else {
    if (latest?.status === 'awaiting_review' || latest?.status === 'awaiting_human') {
      await ports.ledger.transitionNodeRunStatus({
        nodeRunId: latest.id,
        event: { kind: 'cancel-by-supersede', reason: 'branch-skipped' },
        extra: {
          identity: {
            finishedAt: Date.now(),
          },
        },
      })
      ports.status.broadcastNodeStatus(taskId, latest.id, node.id, 'canceled')
    }
    nodeRunId = await ports.ledger.mintNodeRun({
      ...ports.ledger.nodeRunMintIdentityForSlot(
        {
          kind: 'node',
          nodeId: node.id,
          frame: { containerRunId: containerRunId, iteration: iteration },
        },
        { kind: 'current' },
      ),
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'branch-skip',
      containerRunId,
      iteration,
      overrides: {
        inputs: {
          consumedUpstreamRunsJson: consumedJson,
        },
      },
    })
    await ports.ledger.transitionNodeRunStatus({
      nodeRunId,
      event: { kind: 'mark-skipped', reason },
      extra: {
        identity: {
          finishedAt: Date.now(),
        },
      },
    })
  }
  ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'skipped')
  return nodeRunId
}
