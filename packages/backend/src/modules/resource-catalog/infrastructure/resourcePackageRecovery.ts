import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import type {
  ResourcePackageApplyJournalPort,
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'

interface ResourcePackageRecoveryInput {
  readonly journal: ResourcePackageApplyJournalPort
  readonly artifacts: ResourcePackageApplyArtifactRecoveryPort
  readonly now?: () => number
  readonly log?: ResourcePackageApplyMaintenanceLog
}
export function createResourcePackageRecoveryScene(
  input: ResourcePackageRecoveryInput,
): AtomicApplyRecoveryScene<'resource-package'> {
  return {
    key: 'resource-package',
    ...(input.now === undefined ? {} : { now: input.now }),
    list: async () =>
      (await input.journal.list()).map((row) => ({ ...row, error: row.error ?? null })),
    compareAndSet: input.journal.compareAndSet,
    async recover(row, action) {
      if (action === 'compensate') await input.artifacts.compensate(row)
      else await input.artifacts.rollForward(row)
    },
    errors: {
      abandoned: 'converged: crashed before commit',
      committedIncomplete:
        'retryable: committed roll-forward incomplete; inspect resource package apply logs',
      retryable: (error, action) =>
        `retryable: ${action === 'compensate' ? 'compensation' : 'committed roll-forward'} incomplete: ${error instanceof Error ? error.message : String(error)}`,
    },
    warnScene(error) {
      input.log?.warn('resource-package-converge-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
    warn(error, row, action) {
      input.log?.warn(
        action === 'compensate'
          ? 'resource-package-compensation-retryable'
          : 'resource-package-roll-forward-retryable',
        { journalId: row.id, error: error instanceof Error ? error.message : String(error) },
      )
    },
  }
}
