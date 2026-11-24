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
// RFC-567: the same-statement workflow name fragment, for bootstrap to hand to Task Execution's task read models (the task
// list page, the task list route, the lifecycle WS projection and the human-gate badge condition).
export { workflowNameExpression } from './infrastructure/executionResourceQueries'

import { composeCollaborationTaskRolePolicy as bindCollaborationTaskRolePolicy } from './application/adapters/collaboration-adapter'
import { resolveTaskRole } from './application/resourceDefaults'
import { hasResourceAclBypass } from './domain/resourceAccess'

export function composeCollaborationTaskRolePolicy() {
  return bindCollaborationTaskRolePolicy({ resolveTaskRole, hasResourceAclBypass })
}

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition.
export { createResourceCatalogMaintenanceJobHandlers } from './application/maintenanceJobs'

// RFC-448: MCP probe use cases, the shared process-wide operation coordinators, and the
// probe-record read the MCP write clock needs. RFC-538: the probe options and clock are one
// application's probe environment.
export {
  composeMcpProbeOperations,
  createMcpProbeEnvironment,
  type McpProbeEnvironment,
  type McpProbeOptions,
} from './composition/mcpProbeOperations'
export {
  mcpOperationCoordinator,
  pluginOperationCoordinator,
} from './composition/resourceOperationCoordinators'
export { getProbeByMcpId } from './application/mcps/probeRecords'

// RFC-504: the built-in workflow catalog lives in infrastructure; bootstrap takes it via composition.
export { createBuiltinWorkflowCatalog } from './infrastructure/builtinWorkflowCatalog'

// RFC-518: the CrewStation / task-image adapters live in infrastructure/crewstation; bootstrap takes them here.
export { composeCrewStationResourceArtifacts } from './infrastructure/crewstation/crewstationArtifacts'
export { createHostedNativePluginReader } from './infrastructure/crewstation/crewstationNativePlugin'
export { executeTaskImagePlugin } from './infrastructure/crewstation/taskImagePlugin'
