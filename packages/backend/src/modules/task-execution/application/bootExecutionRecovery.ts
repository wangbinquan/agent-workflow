import type {
  BootExecutionRecoveryFactory,
  TaskExecutionBootRecoveryInput,
  TaskExecutionBootRecoveryReport,
} from './ports/bootExecutionRecovery'

/** One four-step sequence, completed before listeners and automatic continuation start. */
export async function runBootExecutionRecovery(
  factory: BootExecutionRecoveryFactory,
  input: TaskExecutionBootRecoveryInput,
): Promise<TaskExecutionBootRecoveryReport> {
  const effects = factory.create(input)
  const preparation = await effects.prepare()
  if (preparation.revokedTaskIds.length > 0) {
    input.log.warn('revoked task owners left by a previous daemon', {
      tasks: preparation.revokedTaskIds.length,
    })
  }

  const { counts: reap, reapRef } = await effects.reap()
  if (reap.tasks > 0 || reap.runs > 0) {
    input.log.warn('reaped orphan runs from previous daemon', {
      tasks: reap.tasks,
      runs: reap.runs,
    })
  }
  const { leases: repairedRuntimeLeases, finalizationRef } = await effects.repair(reapRef)
  if (repairedRuntimeLeases > 0) {
    input.log.info('released runtime session leases held by terminal orphan runs', {
      leases: repairedRuntimeLeases,
    })
  }

  const finalization = await effects.finalize(finalizationRef)
  if (finalization.releasedTaskIds.length > 0 || finalization.outcomeUnknownTaskIds.length > 0) {
    input.log.info('durable task execution recovery finalized', {
      released: finalization.releasedTaskIds.length,
      outcomeUnknown: finalization.outcomeUnknownTaskIds.length,
      recoveredProcessEffects: finalization.recoveredProcessEffectIds.length,
      recoveredCodeHostEffects: finalization.recoveredCodeHostEffectIds.length,
      retryAuthorizedCodeHostEffects: finalization.retryAuthorizedCodeHostEffectIds.length,
    })
  }
  return { revokedTaskIds: preparation.revokedTaskIds, reap, repairedRuntimeLeases, finalization }
}
