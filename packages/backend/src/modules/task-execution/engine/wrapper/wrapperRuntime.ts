import { WRAPPER_NODE_KINDS } from '@agent-workflow/shared'
import type { WrapperNodeExecutionPort } from '../../application/ports/wrapperNodeExecution'
import type { WrapperRunLedgerPort } from '../../application/ports/wrapperRunLedger'
import type { WrapperStatusPublisherPort } from '../../application/ports/wrapperStatusPublisher'
import type { NodeStepOutcome } from '../../domain/nodeExecution'
import {
  WrapperSupersededSignal,
  type WrapperExecutionRequest,
  type WrapperNodeKind,
  type WrapperStrategy,
  type WrapperStrategyMap,
} from '../../domain/wrapperExecution'

function assertClosedRegistry(strategies: WrapperStrategyMap): void {
  const expected = [...WRAPPER_NODE_KINDS].sort()
  const actual = Object.keys(strategies).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`wrapper-runtime-registry-mismatch:${actual.join(',')}:${expected.join(',')}`)
  }
  for (const kind of WRAPPER_NODE_KINDS) {
    if (strategies[kind].kind !== kind) {
      throw new Error(`wrapper-runtime-strategy-kind-mismatch:${kind}:${strategies[kind].kind}`)
    }
  }
}

export class WrapperRuntime implements WrapperNodeExecutionPort {
  constructor(
    private readonly strategies: WrapperStrategyMap,
    private readonly ledger: WrapperRunLedgerPort,
    private readonly publisher: WrapperStatusPublisherPort,
  ) {
    assertClosedRegistry(strategies)
  }

  async execute<K extends WrapperNodeKind>(
    kind: K,
    request: WrapperExecutionRequest<K>,
  ): Promise<NodeStepOutcome> {
    try {
      const strategy = this.strategies[kind] as WrapperStrategy<K>
      const preparation = await strategy.prepare(request)
      if (preparation.kind === 'rejected') return preparation.outcome

      const generation = await this.ledger.openGeneration(kind, request)
      if (generation.enteredRunning) {
        this.publisher.publish({
          taskId: request.task.taskId,
          nodeRunId: generation.runId,
          nodeId: request.node.id,
          kind,
          status: 'running',
        })
      }

      const settlement = await preparation.execute(generation)
      await this.ledger.settle(generation, settlement)
      this.publisher.publish({
        taskId: request.task.taskId,
        nodeRunId: generation.runId,
        nodeId: request.node.id,
        kind,
        status: settlement.rowStatus,
      })
      return settlement.outcome
    } catch (error) {
      if (error instanceof WrapperSupersededSignal) return error.outcome
      throw error
    }
  }
}
