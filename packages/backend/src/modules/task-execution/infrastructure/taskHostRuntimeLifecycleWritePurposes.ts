import type {
  TaskRuntimeLifecyclePersistence,
  TaskRuntimeLifecycleWritePurposes,
} from '../application/ports/taskRuntimeLifecyclePersistence'
import {
  withTaskHostNewWork,
  withTaskHostIssuedAck,
  type TaskHostWriteBinding,
} from './hostExecutionWriteTransaction'
import type { DrizzleTaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'

/** Both views retain the original adapter, method and receiver. */
export function createSelectedTaskRuntimeLifecycleWritePurposes(input: {
  readonly runtimeLifecycle: DrizzleTaskRuntimeLifecyclePersistence
  readonly hostWrites: TaskHostWriteBinding
}): TaskRuntimeLifecycleWritePurposes {
  const { runtimeLifecycle, hostWrites: binding } = input
  const trySet = runtimeLifecycle.trySetWithHostWrite
  function view(
    write: typeof withTaskHostNewWork | typeof withTaskHostIssuedAck,
  ): TaskRuntimeLifecyclePersistence {
    return Object.freeze({
      trySet(input) {
        return trySet.call(runtimeLifecycle, input, binding, write)
      },
    } satisfies TaskRuntimeLifecyclePersistence)
  }
  return Object.freeze({
    preparation: view(withTaskHostNewWork),
    issuedResults: view(withTaskHostIssuedAck),
  })
}
