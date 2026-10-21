// RFC-388: represent live test drivers in the execution module's real runtime registry.
import { ulid } from 'ulid'
import type { TaskExecutionModule } from '@/modules/task-execution/composition'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'

export function attachTestTaskRuntime(
  module: TaskExecutionModule,
  taskId: string,
  controller = new AbortController(),
) {
  const token = createOwnershipToken({
    taskId,
    identity: createWorkerIdentity({ ownerId: ulid(), daemonGeneration: module.daemonGeneration }),
    epoch: 1,
    ownerRevision: 1,
    leaseUntil: Date.now() + 60_000,
  })
  const permit = module.claimGate.enter()
  module.claimGate.bind(permit, token)
  try {
    const result = module.runtimeRegistry.tryAttach({ token, permit, controller, intentId: ulid() })
    if (result !== 'attached') throw new Error(`test runtime attach failed: ${result}`)
  } finally {
    module.claimGate.leave(permit)
  }
  return {
    token,
    controller,
    release() {
      module.runtimeRegistry.release({ token, controller })
      module.runtimeRegistry.settle(token)
    },
  }
}
