import type {
  TaskExecutionRecoveryFinalization,
  TaskExecutionRecoveryPreparation,
} from '../recoverTaskExecutions'
import type { TaskExecutionPersistence } from './taskExecutionPersistence'
import type { RuntimeSessionLeaseOperations } from './runtimeSessionLeaseOperations'
import type {
  CodeHostProbeOutcome,
  CodeHostRecoveryDescriptor,
} from '../../domain/codeHostRecovery'
import type { ExclusiveDaemonLockProof } from '../../domain/ownership'

export interface ReapResult {
  tasks: number
  runs: number
}

export interface BootRecoveryLogger {
  readonly info: (message: string, fields?: Record<string, unknown>) => void
  readonly warn: (message: string, fields?: Record<string, unknown>) => void
}

export interface TaskExecutionBootRecoveryInput {
  readonly persistence: Pick<TaskExecutionPersistence, 'recovery' | 'recoveryAdministration'>
  readonly runtimeSessionLeases: RuntimeSessionLeaseOperations
  readonly lockProof: ExclusiveDaemonLockProof
  readonly codeHostProbe?: (descriptor: CodeHostRecoveryDescriptor) => Promise<CodeHostProbeOutcome>
  readonly log: BootRecoveryLogger
  readonly recoveryEffects?: BootExecutionRecoveryFactory
}

export interface TaskExecutionBootRecoveryReport {
  readonly revokedTaskIds: readonly string[]
  readonly reap: ReapResult
  readonly repairedRuntimeLeases: number
  readonly finalization: TaskExecutionRecoveryFinalization
}

/** The selected pairing interprets each reference; the common sequence only forwards it. */
export type BootExecutionRecoveryRef = object
type MaybeAsync<T> = T | Promise<T>

export interface BootExecutionRecoveryFamily {
  prepare(): MaybeAsync<TaskExecutionRecoveryPreparation>
  reap(): MaybeAsync<{ readonly counts: ReapResult; readonly reapRef: BootExecutionRecoveryRef }>
  repair(reapRef: BootExecutionRecoveryRef): MaybeAsync<{
    readonly leases: number
    readonly finalizationRef: BootExecutionRecoveryRef
  }>
  finalize(finalizationRef: BootExecutionRecoveryRef): MaybeAsync<TaskExecutionRecoveryFinalization>
}

export interface BootExecutionRecoveryFactory {
  create(input: TaskExecutionBootRecoveryInput): BootExecutionRecoveryFamily
}
