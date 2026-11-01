import type { CrossClarifyNodeExecutionPorts } from '../../../application/ports/humanGateNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import { findQuestionerNodeForCrossClarify } from '@agent-workflow/shared'

export async function runCrossClarifyNode(
  ports: CrossClarifyNodeExecutionPorts,
  args: NodeStepRequest<'clarify-cross-agent'>,
): Promise<NodeStepOutcome> {
  const { taskId, definition } = ports
  const { node, iteration } = args
  // RFC-056: cross-clarify nodes are activated by the questioner emitting
  // <workflow-clarify> — the runner forwards into createClarifyRound(kind='cross')
  // which mints a fresh node_run row and parks it at 'awaiting_human'. The
  // scheduler should NOT eagerly insert a pending row on every scan; doing
  // so accumulates orphan pending rows (one per scheduler tick, the user
  // saw 21 pile up on a parked task) because nothing consumes them — the
  // runner path always inserts its OWN row via createClarifyRound(kind='cross')
  // rather than upgrading whatever the scheduler pre-baked.
  //
  // Two legitimate scheduler responsibilities remain:
  //   1. Persistent-stop short-circuit: if this node has a prior
  //      directive='stop' session, mark a fresh done row so cascade
  //      reruns of the cross-clarify branch can advance past it without
  //      parking awaiting_human.
  //   2. Missing-questioner runtime defense: validator should catch
  //      this earlier, but if the workflow snapshot has no questioner
  //      wired, fail explicitly.
  //
  // For the common case (no stop, has questioner), do NOTHING — the
  // runner will create the node_run when the questioner emits clarify.
  // If a live row already exists (pending or awaiting_human) from a
  // prior runner-side creation, also do nothing — idempotency guard.
  const liveRows = await ports.rows.list({
    taskId,
    nodeId: node.id,
    iteration,
  })
  const hasLive = liveRows.some((r) => r.status === 'pending' || r.status === 'awaiting_human')
  if (hasLive) {
    return { kind: 'ok', summary: '', message: 'cross-clarify-live-row-exists' }
  }
  // Validator runtime defense: a node without a questioner means the
  // workflow is malformed — fail and let the user see it in the UI.
  if (findQuestionerNodeForCrossClarify(definition, node.id) === undefined) {
    const failId = await ports.ledger.mintNodeRun({
      ...ports.ledger.nodeRunMintIdentityForSlot(
        {
          kind: 'node',
          nodeId: node.id,
          frame: { containerRunId: args.containerRunId, iteration: iteration },
        },
        { kind: 'current' },
      ),
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'cross-clarify-guard',
      containerRunId: args.containerRunId,
      iteration,
    })
    await ports.ledger.setNodeRunStatus({
      nodeRunId: failId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'cross-clarify-input-source-missing-at-runtime',
      extra: {
        identity: {
          finishedAt: Date.now(),
        },
      },
    })
    return {
      kind: 'failed',
      summary: `cross-clarify node ${node.id} has no questioner input`,
      message: 'cross-clarify-input-source-missing-at-runtime',
    }
  }
  // Persistent-stop check: if the questioner node's node-level clarify directive is
  // 'stop', mint a done row immediately so the workflow advances past this point
  // without parking awaiting_human.
  // RFC-132 T7: the questioner node's directive (task_node_clarify_directives) is the
  // single source of truth (answer-stop + canvas toggle both write it; node
  // last-write-wins subsumes the RFC-123 recency gate). The questioner is guaranteed
  // to exist here (the missing-questioner guard above already failed the node), so the
  // fallback is defensive only.
  const reenableQuestionerNodeId = findQuestionerNodeForCrossClarify(definition, node.id)
  const stopped = reenableQuestionerNodeId
    ? (await ports.getNodeClarifyDirective({
        taskId,
        nodeId: reenableQuestionerNodeId,
      })) === 'stop'
    : false
  if (stopped) {
    const stopRunId = await ports.ledger.mintNodeRun({
      ...ports.ledger.nodeRunMintIdentityForSlot(
        {
          kind: 'node',
          nodeId: node.id,
          frame: { containerRunId: args.containerRunId, iteration: iteration },
        },
        { kind: 'current' },
      ),
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'cross-clarify-guard',
      containerRunId: args.containerRunId,
      iteration,
    })
    // RFC-217 T9: the pending→done short-circuit transition (+ its reason
    // string) is owned by the clarify service — single dispatch policy.
    const dispatched = await ports.inspectCrossClarify({
      taskId,
      crossClarifyNodeId: node.id,
      nodeRunId: stopRunId,
      definition,
    })
    // Codex impl-gate P2-3: honor the helper's verdict. A user flipping the
    // questioner's directive stop→continue between the outer read and the
    // helper's re-read leaves the fresh row PENDING ('awaiting') — reporting
    // completion then would let clients disagree with persisted state and
    // strand the pending row. Retire the speculative mint and fall through
    // to the common awaiting path (the runner mints its own row on emit).
    if (dispatched.kind !== 'short-circuit-stop') {
      await ports.ledger.setNodeRunStatus({
        nodeRunId: stopRunId,
        to: 'canceled',
        allowedFrom: ['pending'],
        reason: 'cross-clarify-stop-race',
        extra: {
          identity: {
            finishedAt: Date.now(),
          },
        },
      })
      return { kind: 'ok', summary: '', message: 'cross-clarify-stop-race' }
    }
    ports.status.broadcastNodeStatus(taskId, stopRunId, node.id, 'done')
    return { kind: 'ok', summary: '', message: 'cross-clarify-persistent-stop' }
  }
  // Common path: no live row, no persistent stop, questioner valid — and the
  // questioner has already settled without asking (this node is only ready once
  // its questioner is done). RFC-354 D7: the gate never triggered, settle it as
  // a `skipped` row; a question emitted by a LATER questioner run mints its own
  // fresher park row through createClarifyRound(kind='cross').
  return ports.settleIdleClarify(args)
}
