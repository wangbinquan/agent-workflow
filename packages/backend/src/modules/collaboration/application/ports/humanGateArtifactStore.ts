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
  /** Pure planning: logical artifact keys and digest, without storage effects. */
  planReviewArtifact(input: {
    readonly operationId: string
    readonly artifactKey: string
    readonly finalPath: string
    readonly body: string
  }): PlannedReviewArtifact
  /** A receipt means the content has been durably staged or published. */
  stageReviewArtifact(plan: PlannedReviewArtifact, body: string): string | Promise<string>
  finalizeReviewArtifact(artifact: HumanGateArtifactSnapshot): string | Promise<string>
  cleanupReviewArtifact(artifact: HumanGateArtifactSnapshot): void | Promise<void>
}
