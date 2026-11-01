import type { TaskMechanicsState } from './taskMechanicsState'
import { createWrapperMechanicsPorts } from './wrapperMechanics'
import type { WrapperRunLedgerPorts } from '../application/ports/wrapperRunLedger'
import type { WrapperStatusPublisherPort } from '../application/ports/wrapperStatusPublisher'
import { FanoutStrategy } from '../engine/wrapper/fanoutStrategy'
import { GitStrategy } from '../engine/wrapper/gitStrategy'
import { LoopStrategy } from '../engine/wrapper/loopStrategy'
import { createWrapperRunLedger } from '../engine/wrapper/wrapperRunLedger'
import { WrapperRuntime } from '../engine/wrapper/wrapperRuntime'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { createLogger } from '@/util/log'

/** RFC-413 — the wrapper run ledger's ports over one execution state; every value is read on use. */
export function createWrapperRunLedgerPorts(state: TaskMechanicsState): WrapperRunLedgerPorts {
  return {
    get taskId() {
      return state.taskId
    },
    get definition() {
      return state.definition
    },
    get containerOf() {
      return state.containerOf
    },
    get execution() {
      return state.opts.executionContext
    },
    get log() {
      return createLogger('scheduler')
    },
    persistence: {
      get wrapperRuns() {
        return state.opts.persistence.wrapperRuns
      },
      get nodeRuns() {
        return state.opts.persistence.nodeRuns
      },
      get nodeExecution() {
        return state.opts.persistence.nodeExecution
      },
    },
    consumedInputs: (record) => prepareConsumedInputs({ record }),
  }
}

export function createWrapperStatusPublisher(): WrapperStatusPublisherPort {
  return {
    publish(receipt) {
      broadcastNodeStatus(receipt.taskId, receipt.nodeRunId, receipt.nodeId, receipt.status)
    },
  }
}

/** The only concrete WrapperRuntime composition for one admitted task snapshot. */
export function composeWrapperRuntime(state: TaskMechanicsState): WrapperRuntime {
  const ports = createWrapperMechanicsPorts(state, state.log)
  return new WrapperRuntime(
    {
      'wrapper-git': new GitStrategy(ports.data, ports.scopeDriver, ports.workspace),
      'wrapper-loop': new LoopStrategy(ports.data, ports.scopeDriver, ports.workspace),
      'wrapper-fanout': new FanoutStrategy(ports.data, ports.fanoutAttempts),
    },
    createWrapperRunLedger(createWrapperRunLedgerPorts(state)),
    createWrapperStatusPublisher(),
  )
}
