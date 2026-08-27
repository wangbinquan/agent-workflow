import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type { HumanGateArtifactStore } from './ports/humanGateArtifactStore'
import {
  DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
  type HumanGateArtifactSnapshot,
  type HumanGateOperationStore,
} from './ports/humanGateOperationStore'
import type { HumanGateOperationSnapshot } from '../domain/humanGateOperation'

export type PreparedHumanGateRecoveryDisposition = 'retain-for-owner-retry' | 'cleanup-stale'

export interface PreparedHumanGateRecoveryInspector {
  inspectPreparedOperation(
    operation: HumanGateOperationSnapshot,
  ): PreparedHumanGateRecoveryDisposition
}

export interface HumanGateRecoveryReport {
  readonly claimed: number
  readonly retained: number
  readonly finalized: number
  readonly cleaned: number
  readonly failed: number
  readonly errors: readonly string[]
}

export interface HumanGateOperationRecoveryOptions {
  readonly db: DbClient
  readonly operations: HumanGateOperationStore
  readonly artifacts: HumanGateArtifactStore
  readonly preparedInspector: PreparedHumanGateRecoveryInspector
  readonly now?: () => number
  readonly leaseMs?: number
  readonly batchLimit?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class HumanGateOperationRecovery {
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly batchLimit: number

  constructor(private readonly options: HumanGateOperationRecoveryOptions) {
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS
    this.batchLimit = options.batchLimit ?? 50
  }

  runOnce(): HumanGateRecoveryReport {
    const at = this.now()
    const claimed = dbTxSync(this.options.db, (tx) =>
      this.options.operations.claimRecoveryBatchTx({
        tx,
        now: at,
        leaseMs: this.leaseMs,
        limit: this.batchLimit,
      }),
    )
    const report = {
      claimed: claimed.length,
      retained: 0,
      finalized: 0,
      cleaned: 0,
      failed: 0,
      errors: [] as string[],
    }
    for (const operation of claimed) {
      try {
        switch (operation.state) {
          case 'preparing':
            // The owner can deterministically recompute the manifest/body from
            // the same request hash. Recovery never guesses missing prepare data.
            report.retained++
            break
          case 'prepared':
            if (
              this.options.preparedInspector.inspectPreparedOperation(operation) ===
              'retain-for-owner-retry'
            ) {
              report.retained++
              break
            }
            this.beginCleanup(operation, at)
            this.finishCleanup(operation, at)
            report.cleaned++
            break
          case 'committed':
            this.finalizeCommitted(operation, at)
            report.finalized++
            break
          case 'cleanup_pending':
            this.finishCleanup(operation, at)
            report.cleaned++
            break
          case 'completed':
          case 'failed':
            break
        }
      } catch (error) {
        report.failed++
        report.errors.push(`${operation.id}: ${errorMessage(error)}`)
      }
    }
    return report
  }

  private artifactsFor(operationId: string): readonly HumanGateArtifactSnapshot[] {
    return dbTxSync(this.options.db, (tx) =>
      this.options.operations.listArtifactsTx(tx, operationId),
    )
  }

  private beginCleanup(operation: HumanGateOperationSnapshot, at: number): void {
    dbTxSync(this.options.db, (tx) => {
      this.options.operations.markCleanupPendingTx({
        tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
        now: at,
      })
    })
  }

  private finishCleanup(operation: HumanGateOperationSnapshot, at: number): void {
    for (const artifact of this.artifactsFor(operation.id)) {
      this.options.artifacts.cleanupReviewArtifact(artifact)
    }
    dbTxSync(this.options.db, (tx) => {
      this.options.operations.deleteCleanupArtifactsTx({
        tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
      })
      this.options.operations.completeCleanupTx({
        tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
        failureJson: JSON.stringify({
          code: 'prepared-gate-stale-cleaned',
          recoveredAt: at,
        }),
        now: at,
      })
    })
  }

  private finalizeCommitted(operation: HumanGateOperationSnapshot, at: number): void {
    const artifacts = this.artifactsFor(operation.id)
    for (const artifact of artifacts) {
      if (artifact.state === 'finalized') {
        this.options.artifacts.finalizeReviewArtifact(artifact)
        continue
      }
      if (artifact.state !== 'consumed') {
        throw new Error(
          `committed human-gate artifact '${artifact.artifactKey}' is '${artifact.state}'`,
        )
      }
      const receiptJson = this.options.artifacts.finalizeReviewArtifact(artifact)
      dbTxSync(this.options.db, (tx) => {
        this.options.operations.transitionArtifactTx({
          tx,
          operationId: operation.id,
          artifactKey: artifact.artifactKey,
          from: 'consumed',
          to: 'finalized',
          receiptJson,
          expectedClaimEpoch: operation.claimEpoch,
          now: at,
        })
      })
    }
    dbTxSync(this.options.db, (tx) => {
      this.options.operations.completeTx({
        tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
        now: at,
      })
    })
  }
}
