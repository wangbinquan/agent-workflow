import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type { Logger } from '../../../application/ports/executionKernel'
import type { FanoutAttemptPort } from '../../../application/ports/fanoutAttempt'
import { dispatchFanoutAggregator } from './runFanoutAggregator'
import { dispatchFanoutShard } from './runFanoutShard'

/**
 * RFC-407 — the fan-out strategy's attempt port, run by the agent executor's fan-out lines (RFC-287
 * L5 / L6) on the same ports as its other lanes. Each attempt logs through its own child logger.
 */
export function createFanoutAttempts(
  ports: AgentNodeExecutionPorts,
  executionLog: Logger,
): FanoutAttemptPort {
  return {
    dispatchShard(input) {
      return dispatchFanoutShard({
        ports,
        ...input,
        boundaryEdges: [...input.boundaryEdges],
        broadcastInputs: { ...input.broadcastInputs },
        log: executionLog.child(
          `fanout:${input.wrapperId}:${input.innerNode.id}${input.shard === null ? ':shared' : ''}`,
        ),
      })
    },
    dispatchAggregator(input) {
      return dispatchFanoutAggregator({
        ports,
        wrapperId: input.wrapperId,
        wrapperRunId: input.wrapperRunId,
        aggNode: input.node,
        aggAgent: input.agent,
        iteration: input.iteration,
        shards: [...input.shards],
        definition: input.definition,
        scope: input.scope,
        reuseDisabled: input.reuseDisabled,
        log: executionLog.child(`fanout:${input.wrapperId}:aggregator`),
      })
    },
  }
}
