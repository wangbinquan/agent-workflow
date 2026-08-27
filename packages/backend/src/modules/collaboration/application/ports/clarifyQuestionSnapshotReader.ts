// RFC-333 — exact read port used while preparing a clarify gate projection.

import type { DbTxSync } from '@/db/txSync'

export interface ClarifyQuestionSnapshot {
  readonly id: string
  readonly taskId: string
  readonly sourceKind: 'self' | 'cross' | 'manual'
  readonly iteration: number
  readonly loopIter: number
  readonly questionTitle: string
  readonly defaultTargetNodeId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ClarifyQuestionSnapshotReader {
  findTx(input: {
    readonly tx: DbTxSync
    readonly originNodeRunId: string
    readonly questionId: string
    readonly roleKind: 'self' | 'questioner'
  }): ClarifyQuestionSnapshot | null
}
