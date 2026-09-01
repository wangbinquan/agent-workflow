// RFC-333 — exact read port used while preparing a clarify gate projection.

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
  find(input: {
    readonly originNodeRunId: string
    readonly questionId: string
    readonly roleKind: 'self' | 'questioner'
  }): Promise<ClarifyQuestionSnapshot | null>
}
