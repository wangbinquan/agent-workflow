// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import type { IntentMaintenanceCommands } from '../public/commands'
import type { AtomicApplyRecovery } from '@/platform/contracts/atomicApply'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

export function createIntentMaintenanceJobHandlers(
  commands: IntentMaintenanceCommands,
  atomicApply: Pick<AtomicApplyRecovery<'intent' | 'resource-package'>, 'converge'>,
): Pick<MaintenanceJobHandlers, 'intentScratchGc' | 'intentRecovery'> {
  return {
    async intentScratchGc(input) {
      const payload = parseMaintenanceJobPayload('intentScratchGc', input.payload)
      const { removed } = await commands.scratch.sweep({
        retentionHours: payload.retentionHours,
      })
      return { counters: { removed }, delta: NONE }
    },
    async intentRecovery(input) {
      const payload = parseMaintenanceJobPayload('intentRecovery', input.payload)
      const result = await commands.recovery.recover({
        recoverTurnIds: payload.recoverTurnIds,
      })
      const applies = await atomicApply.converge({
        intent: payload.activeIntentApplyJournalIds,
        'resource-package': payload.activeBundleApplyIds,
      })
      return {
        counters: {
          failed: applies.failed,
          rolledForward: applies.rolledForward,
          queuedWorkingSets: result.queuedWorkingSets,
          orphanedTurns: result.orphanedTurns,
        },
        delta: { kind: 'intent-queued', sessionIds: [...result.queuedSessionIds] },
      }
    },
  }
}
