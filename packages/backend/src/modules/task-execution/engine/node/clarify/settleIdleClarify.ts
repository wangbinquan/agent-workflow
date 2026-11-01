import type { ClarifyNodeExecutionPorts } from '../../../application/ports/humanGateNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'

/**
 * RFC-354 D7 — a clarify gate visited with no open round. Nobody asked, so the
 * gate never triggered: the node settles as a `skipped` row in this frame,
 * exactly like a closed branch, instead of "completing" without any row. When
 * an agent later asks, collaboration mints a fresher `awaiting_human` park row
 * and the node parks; the answer closes that row as `done`. Runner-emitted
 * questions open their own round through collaboration, so every node's
 * lifecycle stays row-backed.
 */
export async function settleIdleClarify(
  ports: ClarifyNodeExecutionPorts,
  args: NodeStepRequest<'clarify' | 'clarify-cross-agent'>,
): Promise<NodeStepOutcome> {
  const { taskId, log } = ports
  const { node, iteration } = args
  const existing = await ports.rows.list({
    taskId,
    nodeId: node.id,
    containerRunId: args.containerRunId,
    iteration,
  })
  const selected = await ports.selection.current(taskId, {
    kind: 'node',
    nodeId: node.id,
    frame: { containerRunId: args.containerRunId, iteration },
  })
  const latest = existing.find((row) => row.id === selected?.id)
  if (
    latest?.status === 'pending' ||
    latest?.status === 'running' ||
    latest?.status === 'awaiting_human' ||
    latest?.status === 'awaiting_review'
  ) {
    // A live row belongs to someone else's lifecycle — a session opened between
    // the frontier's read and this visit, or a pending anchor collaboration is
    // about to park on. Leave it alone; the scope reads it at the next derivation.
    return { kind: 'ok', summary: '', message: 'clarify-gate-open' }
  }
  await ports.recordSkippedRun({
    node,
    containerRunId: args.containerRunId,
    iteration,
    latest,
    reason: 'clarify-gate-idle',
    consumedJson: '{}',
  })
  log.info('clarify gate idle — settled as skipped', { nodeId: node.id, iteration })
  return { kind: 'ok', summary: '', message: 'clarify-gate-idle' }
}
