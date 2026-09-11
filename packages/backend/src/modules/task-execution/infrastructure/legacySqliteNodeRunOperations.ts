import type { ProviderNeutralDatabase } from '@/db/query'
import { composeRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { DrizzleNodeExecutionPersistence } from './nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import { DrizzleNodeRunRuntimePersistence } from './nodeRunRuntimePersistence'

export type LegacySqliteNodeRunDatabase = ProviderNeutralDatabase

/** SQLite compatibility aggregate; new bootstrap code composes the same ports by provider. */
export function createLegacySqliteNodeRunOperations(db: ProviderNeutralDatabase) {
  return Object.freeze({
    lifecycle: new DrizzleNodeRunLifecyclePersistence(db),
    projections: new DrizzleNodeExecutionPersistence(db),
    runtimes: new DrizzleNodeRunRuntimePersistence(db),
    runtimeRegistry: composeRuntimeRegistryOperations(db),
  })
}

// RFC-359：同步的事务内铸行入口（`mintLegacySqliteNodeRunInTx` → `sqliteNodeRunMintParticipant.ts`）
// 已退役——它在 src 侧只有 `services/nodeRunMint.ts#mintNodeRunTx` 一层转发，而那一层生产零调用方。
// 要在自己的事务里铸行的调用方走中立的 `createNodeRunMintParticipantInTx(tx)`：同一个
// `nodeRunMintProgram`，只是异步解释。
