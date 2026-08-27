// RFC-333 — task-execution's purpose-specific lifecycle dependency.
// Application orchestration owns the transaction, while infrastructure binds
// these exact human-gate transitions to the legacy lifecycle implementation.

import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'

export type HumanGateTaskTransition =
  | 'park-review'
  | 'park-human'
  | 'release-review'
  | 'release-human'

export interface HumanGateTaskLifecycle {
  readManualParkCandidateTx(tx: DbTxSync, taskId: string): Readonly<{ taskRevision: number }> | null
  transitionTx(input: {
    readonly tx: DbTxSync
    readonly taskId: string
    readonly expectedTaskRevision: number
    readonly transition: HumanGateTaskTransition
    readonly now: number
  }): Readonly<{ taskRevision: number }>
  notifyParkAfterCommit(
    db: DbClient,
    taskId: string,
    status: 'awaiting_review' | 'awaiting_human',
  ): void
}
