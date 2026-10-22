import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createMcpProbeStore } from '../infrastructure/mcpProbeStore'
import type { McpProbeStore } from '../public/participants'

/** 一份装配，两个 provider 共用（RFC-359 W4-D16）。 */
export function composeMcpProbeStore(db: PersistenceDb): McpProbeStore {
  return createMcpProbeStore(db)
}
