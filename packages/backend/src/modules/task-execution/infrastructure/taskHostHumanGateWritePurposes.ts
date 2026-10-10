import type {
  HumanGateTaskLifecycle,
  HumanGateTaskWritePurposes,
} from '../application/ports/humanGateTaskLifecycle'
import {
  withTaskHostNewWork,
  withTaskHostIssuedAck,
  type TaskHostWriteBinding,
} from './hostExecutionWriteTransaction'
import type { DatabaseHumanGateTaskLifecyclePersistence } from './humanGateTaskLifecyclePersistence'

/** Retain each original adapter method and receiver in both complete views. */
export function createSelectedHumanGateTaskWritePurposes(input: {
  readonly humanGateLifecycle: DatabaseHumanGateTaskLifecyclePersistence
  readonly hostWrites: TaskHostWriteBinding
}): HumanGateTaskWritePurposes {
  const { humanGateLifecycle, hostWrites: binding } = input
  const park = humanGateLifecycle.parkPreparedWithHostWrite
  const settle = humanGateLifecycle.settleManualQuestionParksWithHostWrite
  const trySet = humanGateLifecycle.trySetWhenNoManualQuestionParksWithHostWrite
  function view(
    write: typeof withTaskHostNewWork | typeof withTaskHostIssuedAck,
  ): HumanGateTaskLifecycle {
    return Object.freeze({
      parkPrepared(input) {
        return park.call(humanGateLifecycle, input, binding, write)
      },
      settleManualQuestionParks(input) {
        return settle.call(humanGateLifecycle, input, binding, write)
      },
      trySetWhenNoManualQuestionParks(input) {
        return trySet.call(humanGateLifecycle, input, binding, write)
      },
    } satisfies HumanGateTaskLifecycle)
  }
  return Object.freeze({
    preparation: view(withTaskHostNewWork),
    issuedResults: view(withTaskHostIssuedAck),
  })
}
