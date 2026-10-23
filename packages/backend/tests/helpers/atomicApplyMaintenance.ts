// RFC-395 II-a A6 — 旧旅程测试依次调用生产 turn 恢复与 journal 机制；这里不构造 worker graph。
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import { composeIntentMaintenanceCommandsForDatabase as composeIntentMaintenance } from '@/modules/intent/composition/maintenance'
import { composeIntentApplyRecoveryScene } from '@/modules/intent/composition/applyMaintenance'

type Input = Parameters<typeof composeIntentMaintenance>[0] &
  Parameters<typeof composeIntentApplyRecoveryScene>[0] & {
    readonly resourcePackages?: AtomicApplyRecoveryScene<'resource-package'>
  }
export function composeIntentMaintenanceCommandsForDatabase(input: Input) {
  const intent = composeIntentMaintenance(input)
  const applies = createAtomicApplyRecovery(
    [
      composeIntentApplyRecoveryScene(input),
      ...(input.resourcePackages === undefined ? [] : [input.resourcePackages]),
    ],
    input.now,
  )
  return {
    scratch: intent.scratch,
    recovery: {
      bootTurnIds: intent.recovery.bootTurnIds,
      async recover(command: {
        readonly recoverTurnIds: readonly string[]
        readonly activeIntentApplyJournalIds: readonly string[]
        readonly activeBundleApplyIds: readonly string[]
        readonly now?: number
      }) {
        const turns = await intent.recovery.recover({
          recoverTurnIds: command.recoverTurnIds,
          ...(command.now === undefined ? {} : { now: command.now }),
        })
        const journals = await applies.converge({
          intent: command.activeIntentApplyJournalIds,
          ...(input.resourcePackages === undefined
            ? {}
            : { 'resource-package': command.activeBundleApplyIds }),
        } as Parameters<typeof applies.converge>[0])
        return { ...turns, ...journals }
      },
    },
  }
}
