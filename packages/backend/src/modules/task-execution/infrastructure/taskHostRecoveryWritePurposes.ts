import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  TaskBootOrphanOperations,
  TaskPeriodicRecoveryOperations,
  TaskRecoveryWritePurposes,
  TaskResourceRecoveryGrant,
  TaskRuntimeSessionLeaseRepairOperations,
} from '../application/ports/taskRecoveryWritePurposes'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { DrizzleTaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'
import type { DrizzleNodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import type { TaskHostWriteBinding } from './hostExecutionWriteTransaction'
import {
  captureTaskResourceRecoveryWrite,
  type TaskResourceRecoveryWrite,
} from './taskResourceRecoveryWrite'
import { createRuntimeSessionLeaseOperations } from './runtimeSessionLeaseOperations'
import { DrizzleTaskExecutionRecoveryPersistence } from './taskExecutionRecovery'

export interface TaskRecoveryAdministrationPurposeDependencies {
  readonly taskLifecycle: Pick<DrizzleTaskRuntimeLifecyclePersistence, 'trySet' | 'trySetWithGuard'>
  readonly nodeLifecycle: Pick<DrizzleNodeRunLifecyclePersistence, 'transition'>
  readonly runtimeLeaseOperations: TaskRuntimeSessionLeaseRepairOperations
  readonly eventWrite: TaskResourceRecoveryWrite
}

/** Named views select original kernels; no Task admission or recovery SQL is recreated. */
export function createSelectedTaskRecoveryWritePurposes(input: {
  readonly db: ProviderNeutralDatabase
  readonly hostWrites: TaskHostWriteBinding
  readonly runtimeLifecycle: DrizzleTaskRuntimeLifecyclePersistence
  readonly nodeLifecycle: DrizzleNodeRunLifecyclePersistence
  readonly createAdministration: (
    dependencies: TaskRecoveryAdministrationPurposeDependencies,
  ) => TaskRecoveryOperations
}): TaskRecoveryWritePurposes {
  const { db, hostWrites, runtimeLifecycle, nodeLifecycle, createAdministration } = input
  const lifecycleWrite = runtimeLifecycle.trySetWithResourceWrite
  const transition = nodeLifecycle.transition
  if ([lifecycleWrite, transition, createAdministration].some((fn) => typeof fn !== 'function')) {
    throw new Error('task-recovery-write-selection-incomplete')
  }
  function select(grant: TaskResourceRecoveryGrant, purpose: 'boot' | 'periodic') {
    const resourceWrite = captureTaskResourceRecoveryWrite(hostWrites, grant, purpose)
    const leases = createRuntimeSessionLeaseOperations(db, resourceWrite)
    const leaseRepair: TaskRuntimeSessionLeaseRepairOperations = Object.freeze({
      repairAfterOrphanReap: leases.repairAfterOrphanReap.bind(leases),
    })
    const operations = createAdministration.call(input, {
      taskLifecycle: Object.freeze({
        trySet(mutation: Parameters<DrizzleTaskRuntimeLifecyclePersistence['trySet']>[0]) {
          return lifecycleWrite.call(runtimeLifecycle, mutation, resourceWrite)
        },
        trySetWithGuard(
          mutation: Parameters<DrizzleTaskRuntimeLifecyclePersistence['trySetWithGuard']>[0],
          guard: Parameters<DrizzleTaskRuntimeLifecyclePersistence['trySetWithGuard']>[1],
        ) {
          return lifecycleWrite.call(runtimeLifecycle, mutation, resourceWrite, guard)
        },
      }),
      nodeLifecycle: Object.freeze({
        transition(mutation: Parameters<DrizzleNodeRunLifecyclePersistence['transition']>[0]) {
          return resourceWrite.write({
            db,
            selection: resourceWrite.selection,
            body: () => transition.call(nodeLifecycle, mutation),
          })
        },
      }),
      runtimeLeaseOperations: leaseRepair,
      eventWrite: resourceWrite,
    })
    return { resourceWrite, operations, leaseRepair }
  }
  return Object.freeze({
    boot(grant: TaskResourceRecoveryGrant) {
      const { resourceWrite, operations, leaseRepair } = select(grant, 'boot')
      const bootOperations: TaskBootOrphanOperations = Object.freeze({
        loadBootOrphanSnapshot: operations.loadBootOrphanSnapshot.bind(operations),
        interruptBootOrphanTask: operations.interruptBootOrphanTask.bind(operations),
        interruptNodeRun: operations.interruptNodeRun.bind(operations),
        recordEvent: operations.recordEvent.bind(operations),
      })
      const recovery = new DrizzleTaskExecutionRecoveryPersistence(db, resourceWrite)
      return Object.freeze({
        recovery: Object.freeze({
          prepare: recovery.prepare.bind(recovery),
          finalize: recovery.finalize.bind(recovery),
        }),
        operations: bootOperations,
        runtimeSessionLeases: leaseRepair,
      })
    },
    periodic(grant: TaskResourceRecoveryGrant) {
      const { operations } = select(grant, 'periodic')
      return Object.freeze({
        listPeriodicReconcileCandidates:
          operations.listPeriodicReconcileCandidates.bind(operations),
        loadPeriodicReconcileSnapshot: operations.loadPeriodicReconcileSnapshot.bind(operations),
        findHeldRuntimeSessionId: operations.findHeldRuntimeSessionId.bind(operations),
        interruptNodeRun: operations.interruptNodeRun.bind(operations),
        repairRuntimeSessionLeaseAfterOrphanReap:
          operations.repairRuntimeSessionLeaseAfterOrphanReap.bind(operations),
        interruptPeriodicTaskIfIdle: operations.interruptPeriodicTaskIfIdle.bind(operations),
        recordEvent: operations.recordEvent.bind(operations),
      } satisfies TaskPeriodicRecoveryOperations)
    },
  })
}
