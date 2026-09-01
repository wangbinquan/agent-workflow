import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { composeSqliteRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { SqliteNodeExecutionPersistence } from './sqliteNodeExecutionPersistence'
import { SqliteNodeRunLifecyclePersistence } from './sqliteNodeRunLifecyclePersistence'
import { createSqliteNodeRunMintParticipantInTx } from './sqliteNodeRunMintParticipant'
import { SqliteNodeRunRuntimePersistence } from './sqliteNodeRunRuntimePersistence'

export type LegacySqliteNodeRunDatabase = DbClient
export type LegacySqliteNodeRunTransaction = DbTxSync

/** SQLite compatibility aggregate; new bootstrap code composes the same ports by provider. */
export function createLegacySqliteNodeRunOperations(db: DbClient) {
  return Object.freeze({
    lifecycle: new SqliteNodeRunLifecyclePersistence(db),
    projections: new SqliteNodeExecutionPersistence(db),
    runtimes: new SqliteNodeRunRuntimePersistence(db),
    runtimeRegistry: composeSqliteRuntimeRegistryOperations(db),
  })
}

export function mintLegacySqliteNodeRunInTx(
  tx: DbTxSync,
  input: Parameters<ReturnType<typeof createSqliteNodeRunMintParticipantInTx>['mint']>[0],
): string {
  return createSqliteNodeRunMintParticipantInTx(tx).mint(input)
}
