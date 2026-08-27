// RFC-333 — post-commit roll-forward of review artifacts.

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type { HumanGateArtifactStore } from './ports/humanGateArtifactStore'
import type { HumanGateOperationStore } from './ports/humanGateOperationStore'

export class CommittedHumanGateFinalizer {
  constructor(
    private readonly db: DbClient,
    private readonly operations: HumanGateOperationStore,
    private readonly artifacts: HumanGateArtifactStore,
  ) {}

  finalize(input: { operationId: string; now?: number }): void {
    const at = input.now ?? Date.now()
    const operation = dbTxSync(this.db, (tx) => this.operations.getTx(tx, input.operationId))
    if (operation === null) throw new Error(`human-gate operation '${input.operationId}' not found`)
    if (operation.state === 'completed') return
    if (operation.state !== 'committed') {
      throw new Error(`human-gate operation '${input.operationId}' is not committed`)
    }
    const artifacts = dbTxSync(this.db, (tx) => this.operations.listArtifactsTx(tx, operation.id))
    for (const artifact of artifacts) {
      const receiptJson = this.artifacts.finalizeReviewArtifact(artifact)
      if (artifact.state === 'finalized') continue
      if (artifact.state !== 'consumed') {
        throw new Error(
          `committed human-gate artifact '${artifact.artifactKey}' is '${artifact.state}'`,
        )
      }
      dbTxSync(this.db, (tx) =>
        this.operations.transitionArtifactTx({
          tx,
          operationId: operation.id,
          artifactKey: artifact.artifactKey,
          from: 'consumed',
          to: 'finalized',
          receiptJson,
          expectedClaimEpoch: operation.claimEpoch,
          now: at,
        }),
      )
    }
    dbTxSync(this.db, (tx) =>
      this.operations.completeTx({
        tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
        now: at,
      }),
    )
  }
}
