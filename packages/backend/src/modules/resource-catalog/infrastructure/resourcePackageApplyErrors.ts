// RFC-395 II-a A6 — 资源包场景保留 HEAD 的错误代码、状态与文案。
import type { AtomicApplyErrors, AtomicApplyRow } from '@/platform/contracts/atomicApply'
import { ConflictError } from '@/util/errors'

export function resourcePackageApplyErrorText(error: unknown): string {
  return error instanceof Error
    ? `${'code' in error && typeof error.code === 'string' ? error.code : 'error'}: ${error.message}`
    : String(error)
}

export const resourcePackageApplyErrors: AtomicApplyErrors<AtomicApplyRow> = {
  failedReplay: (row) =>
    new ConflictError(
      'bundle-apply-failed-replay',
      'this bundle apply already failed; inspect the error and submit a new one',
      { journalId: row.id, error: row.error },
    ),
  unsettledReplay: (row) =>
    new ConflictError(
      'bundle-apply-unsettled',
      'an earlier attempt with this key has not settled yet; retry later',
      { journalId: row.id },
    ),
  claimLost: () => new ConflictError('bundle-apply-unsettled', 'journal claim lost'),
  transitionLost: (phase) =>
    new ConflictError(
      'bundle-apply-unsettled',
      phase === 'commit' ? 'journal commit lost' : 'journal claim lost',
    ),
  failed: resourcePackageApplyErrorText,
  compensationIncomplete: (error, errors) =>
    `retryable: ${resourcePackageApplyErrorText(error)}; compensation: ${errors.map(resourcePackageApplyErrorText).join('; ')}`,
  committedIncomplete:
    'retryable: committed roll-forward incomplete; inspect resource package apply logs',
}
