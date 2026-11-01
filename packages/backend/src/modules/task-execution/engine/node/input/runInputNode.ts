import type { InputNodeExecutionPorts } from '../../../application/ports/virtualIoNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import { pickString } from '../../../domain/nodeFields'

export async function runInputNode(
  ports: InputNodeExecutionPorts,
  args: NodeStepRequest<'input'>,
): Promise<NodeStepOutcome> {
  const { taskId, inputsMap } = ports
  const { node, iteration } = args
  const inputKey = pickString(node, 'inputKey')
  if (inputKey === null) {
    return {
      kind: 'failed',
      summary: `input node ${node.id} missing inputKey`,
      message: 'invalid',
    }
  }
  const value = inputsMap[inputKey] ?? ''
  // RFC-004: an input node's single output port is named after its inputKey,
  // so edges authored on the canvas resolve to the visible handle label.
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
    outputs: [{ portName: inputKey, content: value }],
  })
  ports.status.broadcastNodeStatus(taskId, nrId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}
