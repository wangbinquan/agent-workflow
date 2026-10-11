import { reapOrphanRuns } from '@/services/orphans'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'
import {
  finalizeTaskExecutionRecovery,
  prepareTaskExecutionRecovery,
} from '../../application/recoverTaskExecutions'
import { selectTaskBootRecoveryWrites } from '../../application/taskRecoveryWriteSelection'
import type {
  BootExecutionRecoveryFactory,
  BootExecutionRecoveryFamily,
  ReapResult,
  TaskExecutionBootRecoveryInput,
} from '../../application/ports/bootExecutionRecovery'

export function createLocalBootExecutionRecovery(
  input: TaskExecutionBootRecoveryInput,
): BootExecutionRecoveryFamily {
  let selected: ReturnType<typeof selectTaskBootRecoveryWrites>
  let selectionResolved = false
  function selectAtStage(persistence: TaskExecutionBootRecoveryInput['persistence']) {
    if (!selectionResolved) {
      selected = selectTaskBootRecoveryWrites(persistence, input.recoveryGrant)
      selectionResolved = true
    }
    return selected
  }
  function recoveryAtStage() {
    if (selected !== undefined) return selected.recovery
    const persistence = input.persistence
    return selectAtStage(persistence)?.recovery ?? persistence.recovery
  }
  function orphanOperationsAtStage() {
    if (selected !== undefined) return selected.operations
    const persistence = input.persistence
    return selectAtStage(persistence)?.operations ?? persistence.recoveryAdministration
  }
  const reapResults = new WeakMap<object, ReapResult>()
  const finalizationResults = new WeakMap<
    object,
    { readonly reap: ReapResult; readonly repairedRuntimeLeases: number }
  >()
  return {
    async prepare() {
      return await prepareTaskExecutionRecovery({
        persistence: recoveryAtStage(),
        lockProof: input.lockProof,
      })
    },
    async reap() {
      const reap = await reapOrphanRuns(orphanOperationsAtStage())
      const reapRef = Object.freeze({})
      reapResults.set(reapRef, reap)
      return { counts: reap, reapRef }
    },
    async repair(reapRef) {
      const reap = reapResults.get(reapRef)
      if (reap === undefined) throw new Error('boot recovery reference belongs to another pairing')
      const repairedRuntimeLeases = await repairRuntimeSessionLeasesAfterOrphanReap(
        selected?.runtimeSessionLeases ?? input.runtimeSessionLeases,
        true,
      )
      const finalizationRef = Object.freeze({})
      finalizationResults.set(finalizationRef, { reap, repairedRuntimeLeases })
      return { leases: repairedRuntimeLeases, finalizationRef }
    },
    async finalize(finalizationRef) {
      const result = finalizationResults.get(finalizationRef)
      if (result === undefined)
        throw new Error('boot recovery reference belongs to another pairing')
      const { reap, repairedRuntimeLeases } = result
      return await finalizeTaskExecutionRecovery({
        persistence: recoveryAtStage(),
        lockProof: input.lockProof,
        processEvidence: {
          orphanReaperCompleted: true,
          orphanTasks: reap.tasks,
          orphanRuns: reap.runs,
          repairedRuntimeLeases,
        },
        ...(input.codeHostProbe === undefined ? {} : { codeHostProbe: input.codeHostProbe }),
      })
    },
  }
}

export function createLocalBootExecutionRecoveryFactory(): BootExecutionRecoveryFactory {
  return { create: createLocalBootExecutionRecovery }
}
