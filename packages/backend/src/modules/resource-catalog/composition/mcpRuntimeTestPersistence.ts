import type { ProviderNeutralDatabase } from '@/db/query'
import type { McpRuntimeTestPersistence } from '../application/mcps/runtimeTestPersistence'
import { createMcpRuntimeTestPersistence } from '../infrastructure/mcpRuntimeTestPersistence'
export { createMcpTransactionLifecycle } from '../infrastructure/mcpTransactionLifecycle'
import { createMcpRuntimeTestLeaseOperations } from '../infrastructure/mcpRuntimeTestLease'
import type { McpRuntimeTestLeaseOperations } from '../public/participants'

export interface McpRuntimeTestProviderPersistence {
  readonly persistence: McpRuntimeTestPersistence
  readonly leaseOperations: McpRuntimeTestLeaseOperations
}

/** 一份装配，两个 provider 共用（RFC-359 W4-D16）。 */
export function composeMcpRuntimeTestPersistence(
  db: ProviderNeutralDatabase,
): McpRuntimeTestPersistence {
  return createMcpRuntimeTestPersistence(db)
}

export function composeMcpRuntimeTestProvider(
  db: ProviderNeutralDatabase,
): McpRuntimeTestProviderPersistence {
  return Object.freeze({
    persistence: composeMcpRuntimeTestPersistence(db),
    leaseOperations: createMcpRuntimeTestLeaseOperations(db),
  })
}
