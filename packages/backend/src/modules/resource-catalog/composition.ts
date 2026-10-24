// RFC-395 I-a: schema-only composition root.
export {
  schemaContribution,
  agents,
  mcpProbes,
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessionLeases,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  mcps,
  pluginArtifactGenerations,
  plugins,
  resourceBundleApplies,
  skillContentEntries,
  skillOperationLocks,
  skillOperations,
  skillVersions,
  skills,
  workflows,
  workgroupMembers,
  workgroups,
} from './infrastructure/persistence/schema'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeRealtimeResourceAclPort } from './application/adapters/runtime-management-adapter'
import { createRealtimeResourceAcl } from './infrastructure/realtimeResourceAcl'

export function composeRealtimeResourceAcl(db: PersistenceDb) {
  return composeRealtimeResourceAclPort(createRealtimeResourceAcl(db))
}

import { composeReviewUpstreamAgentPort } from './application/adapters/collaboration-adapter'
import { createReviewUpstreamAgentQuery } from './infrastructure/reviewUpstreamAgent'

export function composeReviewUpstreamAgents(db: PersistenceDb) {
  return composeReviewUpstreamAgentPort(createReviewUpstreamAgentQuery(db))
}

export { createMcpRuntimeTestEventRetentionPhase } from './infrastructure/retentionPhase'
