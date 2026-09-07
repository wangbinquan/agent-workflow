// RFC-349 — bootstrap-only bridge between database-migration admission and
// the root-owned daemon provider session controller.

import type {
  DaemonProviderSessionController,
  ManagedDaemonProviderSession,
} from './daemonProviderSession'
import {
  createDatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmissionLiveState,
} from '@/modules/system-operations/composition'

export type DatabaseMigrationDaemonAdmissionFactory = typeof createDatabaseMigrationDaemonAdmission

export interface DaemonProviderMigrationAdmission {
  readonly migration: DatabaseMigrationDaemonAdmission['migration']
  readonly runBusinessRequest: DatabaseMigrationDaemonAdmission['runBusinessRequest']
  readonly live: () => DatabaseMigrationDaemonAdmissionLiveState
  /** Stop admission first, then close every controller-owned provider session. */
  stop(): Promise<void>
}

export type DaemonProviderMigrationLifecycle = Pick<
  DaemonProviderSessionController<ManagedDaemonProviderSession>,
  'pauseBackgroundWriters' | 'switchProviderComposition' | 'resumeBackgroundWriters' | 'stop'
>

export interface DaemonProviderMigrationInitialGeneration {
  readonly provider: ManagedDaemonProviderSession['provider']
  readonly generationId: string
}

interface CurrentDaemonProviderMigrationAdmissionInput<
  Session extends ManagedDaemonProviderSession,
> {
  readonly controller: DaemonProviderSessionController<Session>
  readonly createAdmission?: DatabaseMigrationDaemonAdmissionFactory
}

interface InitialDaemonProviderMigrationAdmissionInput {
  readonly initial: DaemonProviderMigrationInitialGeneration
  readonly controller: DaemonProviderMigrationLifecycle
  readonly createAdmission?: DatabaseMigrationDaemonAdmissionFactory
}

/**
 * Existing callers derive the generation from their current session. Bootstrap
 * can instead construct admission before opening the initial session, with an
 * exact generation and a complete lifecycle port. Both share the same state
 * machine and retryable shutdown sequence.
 */
export function createDaemonProviderMigrationAdmission<
  Session extends ManagedDaemonProviderSession,
>(input: CurrentDaemonProviderMigrationAdmissionInput<Session>): DaemonProviderMigrationAdmission
export function createDaemonProviderMigrationAdmission(
  input: InitialDaemonProviderMigrationAdmissionInput,
): DaemonProviderMigrationAdmission
export function createDaemonProviderMigrationAdmission<
  Session extends ManagedDaemonProviderSession,
>(
  input:
    | CurrentDaemonProviderMigrationAdmissionInput<Session>
    | InitialDaemonProviderMigrationAdmissionInput,
): DaemonProviderMigrationAdmission {
  const initial = 'initial' in input ? input.initial : input.controller.current()
  const admission = (input.createAdmission ?? createDatabaseMigrationDaemonAdmission)({
    initialProvider: initial.provider,
    initialGenerationId: initial.generationId,
    pauseBackgroundWriters: (lifecycleInput) =>
      input.controller.pauseBackgroundWriters(lifecycleInput),
    switchProviderComposition: (lifecycleInput) =>
      input.controller.switchProviderComposition(lifecycleInput),
    resumeBackgroundWriters: (lifecycleInput) =>
      input.controller.resumeBackgroundWriters(lifecycleInput),
  })

  let admissionStopped = false
  let stopTail: Promise<void> = Promise.resolve()

  const stop = (): Promise<void> => {
    const perform = async (): Promise<void> => {
      if (!admissionStopped) {
        admission.stop()
        admissionStopped = true
      }
      // DaemonProviderSessionController.stop() retains failed close sessions;
      // every adapter retry must therefore reach it again.
      await input.controller.stop()
    }
    const result = stopTail.then(perform, perform)
    stopTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return Object.freeze({
    migration: admission.migration,
    runBusinessRequest: admission.runBusinessRequest,
    live: admission.live,
    stop,
  })
}
