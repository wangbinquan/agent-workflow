// RFC-333 — post-commit roll-forward of review artifacts.

import type { HumanGateArtifactStore } from './ports/humanGateArtifactStore'
import type { HumanGateOperationStore } from './ports/humanGateOperationStore'

export class CommittedHumanGateFinalizer {
  constructor(
    private readonly operations: HumanGateOperationStore,
    private readonly artifacts: HumanGateArtifactStore,
  ) {}

  async finalize(input: { operationId: string; now?: number }): Promise<void> {
    const at = input.now ?? Date.now()
    const operation = await this.operations.get(input.operationId)
    if (operation === null) throw new Error(`human-gate operation '${input.operationId}' not found`)
    if (operation.state === 'completed') return
    if (operation.state !== 'committed') {
      throw new Error(`human-gate operation '${input.operationId}' is not committed`)
    }
    const artifacts = await this.operations.listArtifacts(operation.id)
    for (const artifact of artifacts) {
      const receiptJson = this.artifacts.finalizeReviewArtifact(artifact)
      if (artifact.state === 'finalized') continue
      if (artifact.state !== 'consumed') {
        throw new Error(
          `committed human-gate artifact '${artifact.artifactKey}' is '${artifact.state}'`,
        )
      }
      await this.operations.transitionArtifact({
        operationId: operation.id,
        artifactKey: artifact.artifactKey,
        from: 'consumed',
        to: 'finalized',
        receiptJson,
        expectedClaimEpoch: operation.claimEpoch,
        now: at,
      })
    }
    await this.operations.complete({
      operationId: operation.id,
      expectedClaimEpoch: operation.claimEpoch,
      now: at,
    })
  }
}
