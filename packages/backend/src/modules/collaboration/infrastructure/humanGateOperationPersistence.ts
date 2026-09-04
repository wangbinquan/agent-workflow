// RFC-359 —— 应用层 `HumanGateOperationStore` 端口（db-owning、每次调用自开事务）的**唯一**实现，
// 两个 provider 共用：`DatabaseSession.transaction` 里跑 `DatabaseHumanGateOperationJournal`。
// 替代此前的 `sqliteHumanGateOperationPersistence.ts`（dbTxSync 包同步 store）与
// `postgresqlHumanGateOperationPersistence.ts`（每方法自开 SERIALIZABLE 事务）。

import type { DatabaseSession } from '@/platform/persistence/databaseTransaction'
import type {
  BeginHumanGateOperationInput,
  BegunHumanGateOperation,
  HumanGateOperationStore,
} from '../application/ports/humanGateOperationStore'
import type { HumanGateOperationSnapshot } from '../domain/humanGateOperation'
import {
  DatabaseHumanGateOperationJournal,
  type HumanGateOperationJournal,
} from './humanGateOperationJournal'

export class DatabaseHumanGateOperationPersistence implements HumanGateOperationStore {
  constructor(
    private readonly session: DatabaseSession,
    private readonly journal: HumanGateOperationJournal = new DatabaseHumanGateOperationJournal(),
  ) {}

  async begin(input: BeginHumanGateOperationInput): Promise<BegunHumanGateOperation> {
    return await this.session.transaction(async (tx) => {
      const begun = await this.journal.beginTx({
        tx,
        operationId: input.operationId,
        request: input.request,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
      })
      if (!begun.replayed && input.artifacts !== undefined) {
        await this.journal.declareArtifactsTx({
          tx,
          operationId: begun.operation.id,
          artifacts: input.artifacts,
          now: input.now,
        })
      }
      if (!begun.replayed && input.preparedManifestJson !== undefined) {
        return {
          operation: await this.journal.markPreparedTx({
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
    return await this.session.transaction(
      async (tx) => await this.journal.findByIdempotencyTx({ tx, ...input }),
    )
  }

  async latestGateRevision(
    input: Parameters<HumanGateOperationStore['latestGateRevision']>[0],
  ): Promise<number> {
    return await this.session.transaction(
      async (tx) => await this.journal.latestGateRevisionTx({ tx, ...input }),
    )
  }

  async get(operationId: string): Promise<HumanGateOperationSnapshot | null> {
    return await this.session.transaction(async (tx) => await this.journal.getTx(tx, operationId))
  }

  async listArtifacts(
    operationId: string,
  ): Promise<readonly Awaited<ReturnType<HumanGateOperationJournal['listArtifactsTx']>>[number][]> {
    return await this.session.transaction(
      async (tx) => await this.journal.listArtifactsTx(tx, operationId),
    )
  }

  async claimRecoveryBatch(
    input: Parameters<HumanGateOperationStore['claimRecoveryBatch']>[0],
  ): Promise<readonly HumanGateOperationSnapshot[]> {
    return await this.session.transaction(
      async (tx) => await this.journal.claimRecoveryBatchTx({ tx, ...input }),
    )
  }

  async renewRecoveryClaim(
    input: Parameters<HumanGateOperationStore['renewRecoveryClaim']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.session.transaction(
      async (tx) => await this.journal.renewRecoveryClaimTx({ tx, ...input }),
    )
  }

  async markPrepared(
    input: Parameters<HumanGateOperationStore['markPrepared']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.session.transaction(
      async (tx) => await this.journal.markPreparedTx({ tx, ...input }),
    )
  }

  async commit(
    input: Parameters<HumanGateOperationStore['commit']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.session.transaction(
      async (tx) => await this.journal.commitTx({ tx, ...input }),
    )
  }

  async complete(
    input: Parameters<HumanGateOperationStore['complete']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.session.transaction(
      async (tx) => await this.journal.completeTx({ tx, ...input }),
    )
  }

  async markCleanupPending(
    input: Parameters<HumanGateOperationStore['markCleanupPending']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.session.transaction(
      async (tx) => await this.journal.markCleanupPendingTx({ tx, ...input }),
    )
  }

  async completeCleanup(
    input: Parameters<HumanGateOperationStore['completeCleanup']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.session.transaction(async (tx) => {
      await this.journal.deleteCleanupArtifactsTx({
        tx,
        operationId: input.operationId,
        expectedClaimEpoch: input.expectedClaimEpoch,
      })
      return await this.journal.completeCleanupTx({ tx, ...input })
    })
  }

  async transitionArtifact(
    input: Parameters<HumanGateOperationStore['transitionArtifact']>[0],
  ): Promise<void> {
    await this.session.transaction(
      async (tx) => await this.journal.transitionArtifactTx({ tx, ...input }),
    )
  }
}
