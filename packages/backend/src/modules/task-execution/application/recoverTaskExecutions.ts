// RFC-349 — provider-neutral successor-daemon recovery orchestration.

import type { CodeHostProbeOutcome, CodeHostRecoveryDescriptor } from '../domain/codeHostRecovery'
import type { ExclusiveDaemonLockProof } from '../domain/ownership'

export interface TaskExecutionRecoveryPreparation {
  readonly revokedTaskIds: readonly string[]
}

export interface TaskExecutionRecoveryFinalization {
  readonly releasedTaskIds: readonly string[]
  readonly outcomeUnknownTaskIds: readonly string[]
  readonly recoveredProcessEffectIds: readonly string[]
  readonly recoveredCodeHostEffectIds: readonly string[]
  readonly retryAuthorizedCodeHostEffectIds: readonly string[]
}

export interface TaskExecutionProcessRecoveryEvidence extends Readonly<Record<string, unknown>> {
  readonly orphanReaperCompleted: true
}

/** Provider adapter owns candidate reads and every effect/intent/owner CAS.
 * Network probes remain outside its transaction and are returned as evidence
 * for a second fenced atomic phase. */
export interface TaskExecutionRecoveryPersistence {
  prepare(input: {
    readonly lockProof: ExclusiveDaemonLockProof
    readonly now?: number
  }): Promise<TaskExecutionRecoveryPreparation>
  finalize(input: {
    readonly lockProof: ExclusiveDaemonLockProof
    readonly processEvidence: TaskExecutionProcessRecoveryEvidence
    readonly codeHostProbe?: (
      descriptor: CodeHostRecoveryDescriptor,
    ) => Promise<CodeHostProbeOutcome>
    readonly now?: number
  }): Promise<TaskExecutionRecoveryFinalization>
}

export async function prepareTaskExecutionRecovery(input: {
  readonly persistence: TaskExecutionRecoveryPersistence
  readonly lockProof: ExclusiveDaemonLockProof
  readonly now?: number
}): Promise<TaskExecutionRecoveryPreparation> {
  return await input.persistence.prepare({
    lockProof: input.lockProof,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

export async function finalizeTaskExecutionRecovery(input: {
  readonly persistence: TaskExecutionRecoveryPersistence
  readonly lockProof: ExclusiveDaemonLockProof
  readonly processEvidence: TaskExecutionProcessRecoveryEvidence
  readonly codeHostProbe?: (descriptor: CodeHostRecoveryDescriptor) => Promise<CodeHostProbeOutcome>
  readonly now?: number
}): Promise<TaskExecutionRecoveryFinalization> {
  return await input.persistence.finalize({
    lockProof: input.lockProof,
    processEvidence: input.processEvidence,
    ...(input.codeHostProbe === undefined ? {} : { codeHostProbe: input.codeHostProbe }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
