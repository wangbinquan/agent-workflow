import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { composeSqliteRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { DrizzleNodeExecutionPersistence } from './nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import { createSqliteNodeRunMintParticipantInTx } from './sqliteNodeRunMintParticipant'
import { DrizzleNodeRunRuntimePersistence } from './nodeRunRuntimePersistence'

export type LegacySqliteNodeRunDatabase = DbClient
export type LegacySqliteNodeRunTransaction = DbTxSync

/** SQLite compatibility aggregate; new bootstrap code composes the same ports by provider. */
export function createLegacySqliteNodeRunOperations(db: DbClient) {
  return Object.freeze({
    lifecycle: new DrizzleNodeRunLifecyclePersistence(db),
    projections: new DrizzleNodeExecutionPersistence(db),
    runtimes: new DrizzleNodeRunRuntimePersistence(db),
    runtimeRegistry: composeSqliteRuntimeRegistryOperations(db),
  })
}

export function mintLegacySqliteNodeRunInTx(
  tx: DbTxSync,
  input: Parameters<ReturnType<typeof createSqliteNodeRunMintParticipantInTx>['mint']>[0],
): string {
  return createSqliteNodeRunMintParticipantInTx(tx).mint(input)
}
