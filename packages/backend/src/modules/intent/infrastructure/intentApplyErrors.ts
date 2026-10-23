import type { AtomicApplyErrors, AtomicApplyRow } from '@/platform/contracts/atomicApply'
import { ConflictError } from '@/util/errors'
import { INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE } from '../application/journalConvergence'

export const intentApplyErrors: AtomicApplyErrors<AtomicApplyRow> = {
  failedReplay: (row) =>
    new ConflictError('intent-apply-failed-replay', row.error ?? 'this apply attempt failed', {
      journalId: row.id,
    }),
  unsettledReplay: (row) =>
    new ConflictError('intent-apply-unsettled', 'a prior apply attempt is unsettled; retry later', {
      journalId: row.id,
    }),
  claimLost: () => new ConflictError('intent-apply-unsettled', 'journal claim lost'),
  transitionLost: (phase) =>
    new ConflictError(
      'intent-apply-unsettled',
      phase === 'commit' ? 'journal commit lost' : 'journal claim lost',
    ),
  failed: (error) =>
    error instanceof Error
      ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
      : String(error),
  compensationIncomplete: (error, errors) =>
    `retryable after apply error: ${error instanceof Error ? error.message : String(error)}; compensation incomplete: ${errors.map((item) => (item instanceof Error ? item.message : String(item))).join('; ')}`,
  committedIncomplete: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
}
