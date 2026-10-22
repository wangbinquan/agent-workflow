import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { McpRuntimeTestPersistence } from '../application/mcps/runtimeTestPersistence'
import { createMcpRuntimeTestPersistence } from '../infrastructure/mcpRuntimeTestPersistence'
export { createMcpTransactionLifecycle } from '../infrastructure/mcpTransactionLifecycle'
import { createMcpRuntimeTestLeaseOperations } from '../infrastructure/mcpRuntimeTestLease'
import type { McpRuntimeTestLeaseOperations } from '../application/ports/mcpRuntimeTestLease'

export interface McpRuntimeTestProviderPersistence {
  readonly persistence: McpRuntimeTestPersistence
  readonly leaseOperations: McpRuntimeTestLeaseOperations
}

/** 一份装配，两个 provider 共用（RFC-359 W4-D16）。 */
export function composeMcpRuntimeTestPersistence(
  db: PersistenceDb,
  beforeWrite?: (tx: PersistenceDb) => Promise<void>,
): McpRuntimeTestPersistence {
  return createMcpRuntimeTestPersistence(db, beforeWrite)
}

export function composeMcpRuntimeTestProvider(
  db: PersistenceDb,
  beforeWrite?: (tx: PersistenceDb) => Promise<void>,
): McpRuntimeTestProviderPersistence {
  return Object.freeze({
    persistence: composeMcpRuntimeTestPersistence(db, beforeWrite),
    leaseOperations: createMcpRuntimeTestLeaseOperations(db, beforeWrite),
  })
}
