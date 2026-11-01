import type { OutputNodeExecutionPorts } from '../../../application/ports/virtualIoNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import { resolveWorkflowSourceRef } from '@agent-workflow/shared'
import { loadFrameChain } from '../../../application/frameChain'
import { resolveSourceFrame, type FrameCoordinate } from '../../../domain/environmentChain'

type Binding = { name: string; bind: { nodeId: string; portName: string } }

export async function runOutputNode(
  ports: OutputNodeExecutionPorts,
  args: NodeStepRequest<'output'>,
): Promise<NodeStepOutcome> {
  const { taskId, definition } = ports
  const { node, iteration } = args
  // Output nodes are display-only sinks: no subprocess, no envelope. RFC-354
  // (schema v6): the node's ports ARE its inbound edges — each edge's target
  // port name is the output port, its source the upstream (nodeId, portName)
  // pair. We mint a virtual `done` node_run and snapshot each bound port's
  // content into node_run_outputs so the detail page reads outputs uniformly
  // and lifecycle invariant T3 (task done ⟹ every output node has a done run)
  // is satisfied.
  const bindings: Binding[] = definition.edges
    .filter((edge) => edge.target.nodeId === node.id && edge.boundary === undefined)
    .map((edge) => ({ name: edge.target.portName, bind: { ...edge.source } }))
  const projected: Array<{
    binding: Binding
    row: Awaited<ReturnType<OutputNodeExecutionPorts['input']['readPortRowAtFrame']>>
  }> = []
  const consumed: Record<string, string> = {}
  // RFC-354 — an output node is a consumer like any other: each bound source is
  // read in the frame the environment chain resolves it to.
  const frame: FrameCoordinate = { containerRunId: args.containerRunId, iteration }
  const chain = await loadFrameChain((id) => ports.input.read(id), frame)
  for (const b of bindings) {
    const resolved = resolveWorkflowSourceRef(definition, b.bind, node.id, ports.containerOf)
    if (!resolved.ok) {
      return {
        kind: 'failed',
        summary: `output node ${node.id}: source '${b.bind.nodeId}.${b.bind.portName}' is not exposed by wrapper '${resolved.wrapperId}'`,
        message: 'wrapper-output-boundary-missing',
      }
    }
    const sourceFrame = resolveSourceFrame({
      sourceNodeId: resolved.source.nodeId,
      targetNodeId: node.id,
      parents: ports.containerOf,
      frame,
      containerRowById: chain.lookup,
    })
    if (!sourceFrame.ok) {
      return {
        kind: 'failed',
        summary: `output node ${node.id}: source '${resolved.source.nodeId}.${resolved.source.portName}' is not lexically visible (${sourceFrame.reason})`,
        message: 'closure-binding-unresolved',
      }
    }
    // RFC-193 D16: copy kind + archive reference with the content — an
    // output node is pure projection, its row must stay artifact-readable.
    const row = await ports.input.readPortRowAtFrame(
      taskId,
      resolved.source.nodeId,
      resolved.source.portName,
      sourceFrame.frame,
      definition.nodes.find((source) => source.id === resolved.source.nodeId)?.kind,
    )
    if (row.runId !== null) consumed[resolved.source.nodeId] = row.runId
    projected.push({ binding: b, row })
  }
  // RFC-359：born-done 的行与它的输出同一事务落库（端口 `outputs` 的注释说明了缝在哪）。
  const nrId = await ports.ledger.mintNodeRun({
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
    status: 'done',
    cause: 'io-virtual',
    containerRunId: args.containerRunId,
    iteration,
    overrides: {
      inputs: {
        consumedUpstreamRunsJson: ports.input.prepareConsumedInputs(consumed),
      },
    },
    outputs: projected.map(({ binding, row }) => ({
      portName: binding.name,
      content: row.content,
      kind: row.kind,
      archiveJson: ports.input.copyPortArchive(row.archiveJson),
      // RFC-306: the virtual projection preserves branch activation.
      active: row.active,
    })),
  })
  ports.status.broadcastNodeStatus(taskId, nrId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}
