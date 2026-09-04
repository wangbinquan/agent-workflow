// RFC-355 T4（RFC-294 W4-E4a）—— clientMutationId 重放的出参判据，两个 provider 共用。
//
// 同一个 clientMutationId 再次进来时，journal 里已有一行。三档处置此前在两个 provider 里
// 各写一份（SQLite 内联在 claim 之后，PostgreSQL 是具名的 `replayIntentApplyOutcome`），
// 逐字相同——包括那两个用户可见的错误码。判据只要有两份就迟早会漂。

import { ConflictError } from '@/util/errors'
import type { IntentApplyReceipt } from './ports/intentApplyOperations'

/** journal 行里这三个字段就够判：state / receiptJson / error / id。 */
export interface IntentApplyJournalOutcomeRow {
  readonly id: string
  readonly state: string
  readonly receiptJson: string | null
  readonly error: string | null
}

/**
 * 已提交 ⇒ 原样返回当初的回执；已失败 ⇒ `intent-apply-failed-replay`；
 * prepared / applying 而又没有活着的锁持有者 ⇒ 那是一次崩掉、boot 收敛还没扫到的尝试，
 * **拒绝而不是猜**（`intent-apply-unsettled`）。
 */
export function intentApplyReplayOutcomeOf(row: IntentApplyJournalOutcomeRow): IntentApplyReceipt {
  if (row.state === 'committed' && row.receiptJson !== null) {
    return JSON.parse(row.receiptJson) as IntentApplyReceipt
  }
  if (row.state === 'failed') {
    throw new ConflictError(
      'intent-apply-failed-replay',
      row.error ?? 'this apply attempt failed',
      {
        journalId: row.id,
      },
    )
  }
  throw new ConflictError(
    'intent-apply-unsettled',
    'a prior apply attempt is unsettled; retry later',
    { journalId: row.id },
  )
}
