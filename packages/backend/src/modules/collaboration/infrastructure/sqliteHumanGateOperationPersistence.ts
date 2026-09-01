// RFC-349 — Promise-shaped collaboration operation port backed by the
// synchronous SQLite transaction participant.  No SQLite transaction escapes
// this adapter.

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type {
  BeginHumanGateOperationInput,
  BegunHumanGateOperation,
  HumanGateOperationStore,
} from '../application/ports/humanGateOperationStore'
import type { HumanGateOperationSnapshot } from '../domain/humanGateOperation'
import { HumanGateOperationError } from '../domain/humanGateOperation'
import { SqliteHumanGateOperationStore } from './sqliteHumanGateOperationStore'

export class SqliteHumanGateOperationPersistence implements HumanGateOperationStore {
  private readonly transactions = new SqliteHumanGateOperationStore()

  constructor(private readonly db: DbClient) {}

  async begin(input: BeginHumanGateOperationInput): Promise<BegunHumanGateOperation> {
    return dbTxSync(this.db, (tx) => {
      const begun = this.transactions.beginTx({
        tx,
        operationId: input.operationId,
        request: input.request,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
      })
      if (!begun.replayed && input.artifacts !== undefined) {
        this.transactions.declareArtifactsTx({
          tx,
          operationId: begun.operation.id,
          artifacts: input.artifacts,
          now: input.now,
        })
      }
      if (!begun.replayed && input.preparedManifestJson !== undefined) {
        return {
          operation: this.transactions.markPreparedTx({
            tx,
            operationId: begun.operation.id,
            expectedClaimEpoch: begun.operation.claimEpoch,
            manifestJson: input.preparedManifestJson,
            now: input.now,
          }),
          replayed: false,
        }
      }
      return begun
    })
  }

  async findByIdempotency(
    input: Parameters<HumanGateOperationStore['findByIdempotency']>[0],
  ): Promise<HumanGateOperationSnapshot | null> {
    return dbTxSync(this.db, (tx) => this.transactions.findByIdempotencyTx({ tx, ...input }))
  }

  async latestGateRevision(
    input: Parameters<HumanGateOperationStore['latestGateRevision']>[0],
  ): Promise<number> {
    return dbTxSync(this.db, (tx) => this.transactions.latestGateRevisionTx({ tx, ...input }))
  }

  async get(operationId: string): Promise<HumanGateOperationSnapshot | null> {
    return dbTxSync(this.db, (tx) => this.transactions.getTx(tx, operationId))
  }

  async listArtifacts(
    operationId: string,
  ): Promise<Awaited<ReturnType<HumanGateOperationStore['listArtifacts']>>> {
    return dbTxSync(this.db, (tx) => this.transactions.listArtifactsTx(tx, operationId))
  }

  async claimRecoveryBatch(
    input: Parameters<HumanGateOperationStore['claimRecoveryBatch']>[0],
  ): Promise<readonly HumanGateOperationSnapshot[]> {
    return dbTxSync(this.db, (tx) => this.transactions.claimRecoveryBatchTx({ tx, ...input }))
  }

  async renewRecoveryClaim(
    input: Parameters<HumanGateOperationStore['renewRecoveryClaim']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return dbTxSync(this.db, (tx) => this.transactions.renewRecoveryClaimTx({ tx, ...input }))
  }

  async markPrepared(
    input: Parameters<HumanGateOperationStore['markPrepared']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return dbTxSync(this.db, (tx) => this.transactions.markPreparedTx({ tx, ...input }))
  }

  async commit(
    input: Parameters<HumanGateOperationStore['commit']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return dbTxSync(this.db, (tx) => this.transactions.commitTx({ tx, ...input }))
  }

  async complete(
    input: Parameters<HumanGateOperationStore['complete']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return dbTxSync(this.db, (tx) => this.transactions.completeTx({ tx, ...input }))
  }

  async markCleanupPending(
    input: Parameters<HumanGateOperationStore['markCleanupPending']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return dbTxSync(this.db, (tx) => this.transactions.markCleanupPendingTx({ tx, ...input }))
  }

  async completeCleanup(
    input: Parameters<HumanGateOperationStore['completeCleanup']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return dbTxSync(this.db, (tx) => {
      this.transactions.deleteCleanupArtifactsTx({
        tx,
        operationId: input.operationId,
        expectedClaimEpoch: input.expectedClaimEpoch,
      })
      return this.transactions.completeCleanupTx({ tx, ...input })
    })
  }

  async transitionArtifact(
    input: Parameters<HumanGateOperationStore['transitionArtifact']>[0],
  ): Promise<void> {
    dbTxSync(this.db, (tx) => this.transactions.transitionArtifactTx({ tx, ...input }))
  }
}

export function assertHumanGateOperation(
  operation: HumanGateOperationSnapshot | null,
  operationId: string,
): HumanGateOperationSnapshot {
  if (operation !== null) return operation
  throw new HumanGateOperationError(
    'human-gate-operation-not-found',
    `human-gate operation '${operationId}' does not exist`,
    { operationId },
  )
}
