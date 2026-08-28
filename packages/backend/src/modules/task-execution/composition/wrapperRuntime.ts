import type { LegacyTaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { createWrapperMechanicsPorts } from './wrapperMechanics'
import { createWrapperRunLedger, createWrapperStatusPublisher } from './wrapperRunLifecycle'
import { FanoutStrategy } from '../engine/wrapper/fanoutStrategy'
import { GitStrategy } from '../engine/wrapper/gitStrategy'
import { LoopStrategy } from '../engine/wrapper/loopStrategy'
import { WrapperRuntime } from '../engine/wrapper/wrapperRuntime'

/** The only concrete WrapperRuntime composition for one admitted task snapshot. */
export function composeWrapperRuntime(state: LegacyTaskMechanicsState): WrapperRuntime {
  const ports = createWrapperMechanicsPorts(state, state.log)
  return new WrapperRuntime(
    {
      'wrapper-git': new GitStrategy(ports.data, ports.scopeDriver, ports.workspace),
      'wrapper-loop': new LoopStrategy(ports.data, ports.scopeDriver, ports.workspace),
      'wrapper-fanout': new FanoutStrategy(ports.data, ports.fanoutAttempts),
    },
    createWrapperRunLedger(state),
    createWrapperStatusPublisher(),
  )
}
