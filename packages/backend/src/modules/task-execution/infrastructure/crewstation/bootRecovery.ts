import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionEffectFences,
} from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { ExclusiveDaemonLockProof } from '../../domain/ownership'
import type { BootExecutionRecoveryFactory } from '../../application/ports/bootExecutionRecovery'
import {
  prepareTaskExecutionRecovery,
  finalizeTaskExecutionRecovery,
} from '../../application/recoverTaskExecutions'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'
import type { HostedExecutionStore } from './executionStore'

/** RFC-370 §9.2 V1 — boot recovery never waits on the platform.
 *
 * A remote execution outlives the service process that started it. On boot:
 * - every open hosted process effect attempt is handed off (its writer is the
 *   remote subtask, which the successor run re-registers when it adopts it);
 * - orphan tasks and runs are interrupted exactly as standalone does;
 * - a run whose execution is still unsettled (and not restored from a
 *   snapshot) goes back to `pending` with its ORIGINAL id, so the scheduler
 *   adopts the same platform subtask instead of starting a second model call;
 * - everything no run will adopt is settled by the background settler. */
export function createHostedBootRecovery(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly store: HostedExecutionStore
  readonly proof: () => ExclusiveDaemonLockProof
}): {
  readonly factory: BootExecutionRecoveryFactory
  readonly recoveredTaskIds: () => readonly string[]
} {
  const recovered = new Set<string>()
  return {
    recoveredTaskIds: () => [...recovered],
    factory: {
      create(boot) {
        const proof = input.proof()
        const reapRef = Object.freeze({})
        const finalizationRef = Object.freeze({})
        let repaired = 0
        const counts = { tasks: 0, runs: 0 }
        const adoptableRuns = new Set<string>()
        const handedOffEffects: string[] = []
        return {
          prepare: () =>
            prepareTaskExecutionRecovery({
              persistence: boot.persistence.recovery,
              lockProof: proof,
            }),
          async reap() {
            const bindings = await input.store.unsettled()
            for (const binding of bindings) {
              if (binding.nodeRunId === undefined || binding.cancelReason === 'restored') continue
              adoptableRuns.add(binding.nodeRunId)
            }
            const lease = input.fence.current()
            await databaseSessionFor(input.db).transaction(async (tx) => {
              await input.fence.assertHeld(tx, lease)
              const attempts = await tx
                .select({ attempt: taskExecutionEffectAttempts, effect: taskExecutionEffects })
                .from(taskExecutionEffectAttempts)
                .innerJoin(
                  taskExecutionEffects,
                  eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
                )
                .where(
                  and(
                    eq(taskExecutionEffectAttempts.recoveryClass, 'crewstation-v3-execution'),
                    inArray(taskExecutionEffectAttempts.state, [
                      'prepared',
                      'acting',
                      'recovery-required',
                    ]),
                  ),
                )
              for (const { attempt, effect } of attempts) {
                const binding = bindings.find(
                  (candidate) =>
                    candidate.nodeRunId !== undefined &&
                    attempt.candidateId ===
                      `${candidate.request.kind === 'agent' ? 'agent' : 'script'}:${candidate.nodeRunId}`,
                )
                // The binding is committed before the first platform submit,
                // so its absence proves the attempt never reached the platform.
                const receiptJson = JSON.stringify({
                  v: 2,
                  phase:
                    binding === undefined ? 'crewstation-not-submitted' : 'crewstation-handed-off',
                  executionId: binding?.executionId,
                })
                await tx
                  .update(taskExecutionEffectAttempts)
                  .set({
                    state: binding === undefined ? 'failed-not-applied' : 'succeeded',
                    applicationEvidence:
                      binding === undefined ? 'definitely-not-applied' : 'applied',
                    receiptJson,
                    failureCode: null,
                    settledAt: Date.now(),
                    updatedAt: Date.now(),
                  })
                  .where(eq(taskExecutionEffectAttempts.id, attempt.id))
                await tx
                  .update(taskExecutionEffects)
                  .set({
                    state: binding === undefined ? 'failed' : 'succeeded',
                    receiptJson,
                    failureCode: null,
                    settledAt: Date.now(),
                    updatedAt: Date.now(),
                  })
                  .where(eq(taskExecutionEffects.id, effect.id))
                await tx
                  .update(taskExecutionEffectFences)
                  .set({ releasedAt: Date.now() })
                  .where(
                    and(
                      eq(taskExecutionEffectFences.effectAttemptId, attempt.id),
                      isNull(taskExecutionEffectFences.releasedAt),
                    ),
                  )
                handedOffEffects.push(effect.id)
              }
            })
            const snapshot = await boot.persistence.recoveryAdministration.loadBootOrphanSnapshot()
            for (const task of snapshot.tasks) {
              if (
                await boot.persistence.recoveryAdministration.interruptBootOrphanTask({
                  taskId: task.id,
                  from: task.status,
                  now: Date.now(),
                  failureCode: 'daemon-restart',
                  errorMessage: 'remote execution retained; the next owner adopts it',
                })
              )
                counts.tasks += 1
            }
            for (const run of snapshot.runs) {
              if (run.pid !== null) throw new Error('hosted-recovery-unexpected-local-process')
              await boot.persistence.recoveryAdministration.interruptNodeRun({
                nodeRunId: run.id,
                now: Date.now(),
              })
              counts.runs += 1
            }
            return { counts, reapRef }
          },
          async repair(reference) {
            if (reference !== reapRef) throw new Error('hosted-recovery-reference-mismatch')
            // Interrupted runs are terminal: their session leases are released
            // and an adopting run claims them again with its own nonce.
            repaired += await repairRuntimeSessionLeasesAfterOrphanReap(
              boot.runtimeSessionLeases,
              true,
            )
            return { leases: repaired, finalizationRef }
          },
          async finalize(reference) {
            if (reference !== finalizationRef) throw new Error('hosted-recovery-reference-mismatch')
            const finalized = await finalizeTaskExecutionRecovery({
              persistence: boot.persistence.recovery,
              lockProof: proof,
              processEvidence: {
                orphanReaperCompleted: true,
                transport: 'crewstation-v3-handoff',
                ...counts,
                repairedRuntimeLeases: repaired,
              },
              ...(boot.codeHostProbe === undefined ? {} : { codeHostProbe: boot.codeHostProbe }),
            })
            // Keep the original run identity so the scheduler adopts the same
            // platform subtask. Terminal runs are never reset.
            const lease = input.fence.current()
            await databaseSessionFor(input.db).transaction(async (tx) => {
              await input.fence.assertHeld(tx, lease)
              if (adoptableRuns.size === 0 || finalized.releasedTaskIds.length === 0) return
              const adoptable = and(
                inArray(nodeRuns.id, [...adoptableRuns]),
                eq(nodeRuns.status, 'interrupted'),
                inArray(nodeRuns.taskId, [...finalized.releasedTaskIds]),
              )
              const reset = await tx
                .select({ taskId: nodeRuns.taskId })
                .from(nodeRuns)
                .where(adoptable)
              await tx
                .update(nodeRuns)
                .set({
                  status: 'pending',
                  finishedAt: null,
                  pid: null,
                  spawnBinaryPath: null,
                  spawnLaunchNonce: null,
                })
                .where(adoptable)
              // Only tasks that really kept remote work are resumed at boot.
              for (const row of reset) recovered.add(row.taskId)
            })
            return {
              ...finalized,
              recoveredProcessEffectIds: [
                ...finalized.recoveredProcessEffectIds,
                ...handedOffEffects,
              ],
            }
          },
        }
      },
    },
  }
}
