// RFC-333 — task-execution's purpose-specific lifecycle dependency.
// Application orchestration owns the transaction, while infrastructure binds
// these exact human-gate transitions to the legacy lifecycle implementation.

import type { DbTxSync } from '@/db/txSync'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'

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
    readonly nodeChanges?: readonly TaskNodeChangeV1[]
    readonly committedEventIdentity?: Readonly<{
      operationRef: string
      eventGroupId?: string
      eventGroupOrdinal?: number
      correlationRef?: string | null
      causationRef?: string | null
    }>
  }): Readonly<{ taskRevision: number; eventRefs: readonly CommittedEventRef[] }>
  publishAfterCommit(eventRefs: readonly CommittedEventRef[]): Promise<void>
}
