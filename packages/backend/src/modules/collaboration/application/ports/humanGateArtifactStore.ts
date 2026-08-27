import type { HumanGateArtifactSnapshot } from './humanGateOperationStore'

export interface PlannedReviewArtifact {
  readonly operationId: string
  readonly artifactKey: string
  readonly stagedPath: string
  readonly finalPath: string
  readonly sha256: string
  readonly byteSize: number
}

export interface HumanGateArtifactStore {
  planReviewArtifact(input: {
    readonly operationId: string
    readonly artifactKey: string
    readonly finalPath: string
    readonly body: string
  }): PlannedReviewArtifact
  stageReviewArtifact(plan: PlannedReviewArtifact, body: string): string
  finalizeReviewArtifact(artifact: HumanGateArtifactSnapshot): string
  cleanupReviewArtifact(artifact: HumanGateArtifactSnapshot): void
}
