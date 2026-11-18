// RFC-503 (RFC-294 S10 step 10): Intent's two maintenance commands (scratch sweep and boot recovery), moved here unchanged from
// composition/maintenance.ts as createIntentMaintenanceCommands; the clock is passed in (composition supplies the process clock).
import type { IntentMaintenancePersistence } from './ports/intentPersistence'
import type { IntentScratchStore } from './ports/intentScratchStore'
import type { IntentMaintenanceCommands } from '../public/commands'
import type { IntentBootRecoveryInput, IntentScratchSweepInput } from '../public/commands'

export interface IntentMaintenanceLog {
  info(message: string, fields: Readonly<Record<string, unknown>>): void
  warn(message: string, fields: Readonly<Record<string, unknown>>): void
}

export interface IntentMaintenanceCommandDependencies {
  readonly persistence: IntentMaintenancePersistence
  readonly scratch: IntentScratchStore
  readonly log?: IntentMaintenanceLog
  readonly now: () => number
}

export function createIntentMaintenanceCommands(
  dependencies: IntentMaintenanceCommandDependencies,
): IntentMaintenanceCommands {
  return Object.freeze({
    scratch: Object.freeze({
      async sweep(input: IntentScratchSweepInput) {
        const cutoff = (input.now ?? dependencies.now()) - input.retentionHours * 3_600_000
        const staleTurnIds = await dependencies.scratch.staleTurnIds(cutoff)
        const running = await dependencies.persistence.listRunningTurnIds(staleTurnIds)
        const failed: string[] = []
        let removed = 0
        for (const turnId of staleTurnIds) {
          if (running.has(turnId)) continue
          try {
            await dependencies.scratch.remove(turnId)
            removed += 1
            dependencies.log?.info('intent-scratch-swept', { turnId })
          } catch (error) {
            failed.push(turnId)
            dependencies.log?.warn('intent-scratch-sweep-failed', {
              turnId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        await dependencies.persistence.markScratchSwept({
          cutoff,
          excludedTurnIds: [...running, ...failed],
        })
        return { removed }
      },
    }),
    recovery: Object.freeze({
      bootTurnIds: () => dependencies.persistence.listTurnIdsForBootRecovery(),
      async recover(input: IntentBootRecoveryInput) {
        const orphanedTurns = await dependencies.persistence.recoverTurnsOnBoot({
          turnIds: input.recoverTurnIds,
          now: input.now ?? dependencies.now(),
          reason: 'intent-run-daemon-restart',
        })
        const queuedSessionIds = await dependencies.persistence.listQueuedWorkingSetSessionIds()
        return {
          queuedWorkingSets: queuedSessionIds.length,
          orphanedTurns,
          queuedSessionIds,
        }
      },
    }),
  })
}
