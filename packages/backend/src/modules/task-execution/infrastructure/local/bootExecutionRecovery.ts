import { reapOrphanRuns } from '@/services/orphans'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'
import {
  finalizeTaskExecutionRecovery,
  prepareTaskExecutionRecovery,
} from '../../application/recoverTaskExecutions'
import type {
  BootExecutionRecoveryFactory,
  BootExecutionRecoveryFamily,
  ReapResult,
  TaskExecutionBootRecoveryInput,
} from '../../application/ports/bootExecutionRecovery'

export function createLocalBootExecutionRecovery(
  input: TaskExecutionBootRecoveryInput,
): BootExecutionRecoveryFamily {
  const reapResults = new WeakMap<object, ReapResult>()
  const finalizationResults = new WeakMap<
    object,
    { readonly reap: ReapResult; readonly repairedRuntimeLeases: number }
  >()
  return {
    async prepare() {
      return await prepareTaskExecutionRecovery({
        persistence: input.persistence.recovery,
        lockProof: input.lockProof,
      })
    },
    async reap() {
      const reap = await reapOrphanRuns(input.persistence.recoveryAdministration)
      const reapRef = Object.freeze({})
      reapResults.set(reapRef, reap)
      return { counts: reap, reapRef }
    },
    async repair(reapRef) {
      const reap = reapResults.get(reapRef)
      if (reap === undefined) throw new Error('boot recovery reference belongs to another pairing')
      const repairedRuntimeLeases = await repairRuntimeSessionLeasesAfterOrphanReap(
        input.runtimeSessionLeases,
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
        persistence: input.persistence.recovery,
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
