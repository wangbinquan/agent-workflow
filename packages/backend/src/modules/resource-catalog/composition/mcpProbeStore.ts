import type { ProviderNeutralDatabase } from '@/db/query'
import { createMcpProbeStore } from '../infrastructure/mcpProbeStore'
import type { McpProbeStore } from '../public/participants'

/** 一份装配，两个 provider 共用（RFC-359 W4-D16）。 */
export function composeMcpProbeStore(db: ProviderNeutralDatabase): McpProbeStore {
  return createMcpProbeStore(db)
}
