// RFC-395 I-a: the only production collection point for schema contributions.
import { schemaContribution as contribution0 } from '@/modules/code-capability/composition/schema'
import { historySchemaContribution as contribution1 } from '@/modules/code-capability/composition/schema'
import { schemaContribution as contribution2 } from '@/modules/collaboration/composition/schema'
import { schemaContribution as contribution3 } from '@/modules/development-automation/composition/schema'
import { schemaContribution as contribution4 } from '@/modules/digital-employee/composition/schema'
import { schemaContribution as contribution5 } from '@/modules/event-center/composition/schema'
import { schemaContribution as contribution6 } from '@/modules/identity-access/composition/schema'
import { schemaContribution as contribution7 } from '@/modules/integration/composition/schema'
import { schemaContribution as contribution8 } from '@/modules/intent/composition/schema'
import { schemaContribution as contribution9 } from '@/modules/knowledge-evolution/composition/schema'
import { schemaContribution as contribution10 } from '@/modules/memory/composition/schema'
import { schemaContribution as contribution11 } from '@/platform/committed-events/composition/schema'
import { schemaContribution as contribution12 } from '@/platform/content/composition/schema'
import { schemaContribution as contribution13 } from '@/modules/resource-catalog/composition/schema'
import { schemaContribution as contribution14 } from '@/modules/run-observability/composition/schema'
import { schemaContribution as contribution15 } from '@/modules/runtime-management/composition/schema'
import { schemaContribution as contribution16 } from '@/modules/source-control/composition/schema'
import { schemaContribution as contribution17 } from '@/modules/system-operations/composition/schema'
import { schemaContribution as contribution18 } from '@/modules/task-execution/composition/schema'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { compileContract } from '@/platform/persistence/schema/contract'
import { projectLegacyV2 } from '@/platform/persistence/migration/legacy/v2Contract'

export const persistenceSchema = createSchemaRegistry([
  contribution0,
  contribution1,
  contribution2,
  contribution3,
  contribution4,
  contribution5,
  contribution6,
  contribution7,
  contribution8,
  contribution9,
  contribution10,
  contribution11,
  contribution12,
  contribution13,
  contribution14,
  contribution15,
  contribution16,
  contribution17,
  contribution18,
])
export const explicitSchemaContract = compileContract(persistenceSchema)
let epoch1Contract: ReturnType<typeof projectLegacyV2> | undefined
export function buildLogicalSchemaContract() {
  return (epoch1Contract ??= projectLegacyV2(persistenceSchema))
}

export { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'

export {
  capabilityTemplates,
  repoCapabilityConfig,
  codeAiAttempts,
  codeArtifacts,
  codeFindings,
  codeFixAttempts,
  codeMrLeases,
  codeProducedMrs,
  codePublishIntents,
  codeRoundStages,
  codeTriggerDeliveries,
  codeWorkItems,
  codeWorkObservations,
  codeWorkRounds,
  legacyCodeWorkItemLinks,
} from '@/modules/code-capability/composition/schema'
export {
  clarifyRounds,
  collaborationGateArtifacts,
  collaborationGateOperations,
  docVersions,
  reviewComments,
  reviewNodeReviewers,
  taskCollaborators,
  taskFeedback,
  taskQuestions,
} from '@/modules/collaboration/composition/schema'
export {
  actionTemplateRevisions,
  actionTemplates,
  automationPolicies,
  automationPolicyRevisions,
  developmentActionRuns,
  developmentAdapterDefinitionRevisions,
  developmentAdapterDefinitions,
  developmentAgentAttempts,
  developmentApprovalSagas,
  developmentBundleRefs,
  developmentDecisions,
  developmentDeferredWakes,
  developmentDesigns,
  developmentDesignRevisions,
  developmentDesignProposals,
  developmentDesignBaselines,
  developmentDesignLinks,
  developmentEffects,
  developmentFactSnapshots,
  developmentFeedbackLedger,
  developmentMissionLinks,
  developmentMissionSources,
  developmentMissions,
  developmentMrClaims,
  developmentObjectArtifacts,
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
  developmentRepositoryUploadReceipts,
  developmentStepJoins,
  developmentStepRuns,
  developmentWakeHints,
  digitalEmployeeRevisions,
  digitalEmployees,
  missionInputUploads,
  repositoryEmployeeAssignments,
  verificationProfileRevisions,
  verificationProfiles,
} from '@/modules/development-automation/composition/schema'
export {
  employeeApprovalSagas,
  employeeAttentionBindings,
  employeeCaseEventOrigins,
  employeeCaseInbox,
  employeeCaseMembers,
  employeeCaseMeteringReceipts,
  employeeCaseWorkspaces,
  employeeCases,
  employeeChangeCandidates,
  employeeChannelResults,
  employeeChannels,
  employeeContextLinks,
  employeeContextRecords,
  employeeContextRevisions,
  employeeDefinitionRevisions,
  employeeDefinitions,
  employeeExecutionPolicyRevisions,
  employeeExternalContextBindings,
  employeeInputUploads,
  employeeInvocations,
  employeeJobTemplateRevisions,
  employeeJobTemplates,
  employeeOsOutbox,
  employeeOsSettings,
  employeeOsWriterState,
  employeeReactionArtifacts,
  employeeReactionDispatch,
  employeeReactionRounds,
  employeeRoundWorkspaceStates,
  employeeToolRegistrationRevisions,
  employeeToolRegistrations,
  employeeTypePackages,
  employeeWorkScopeRevisions,
} from '@/modules/digital-employee/composition/schema'
export {
  customEventSourceDefinitions,
  customEventSourceRevisions,
  eventAutomationWorkIntents,
  eventDeliveries,
  eventObserverRuns,
  eventRecords,
  eventResponseRules,
  eventSources,
  eventSubscriptions,
  eventTypeCatalog,
  observerActivations,
} from '@/modules/event-center/composition/schema'
export {
  authLoginPolicy,
  externalIdentities,
  oidcProviders,
  resourceGrants,
  tokenAudit,
  tokenDeleteSnapshot,
  userAccessAudit,
  userIdentities,
  userPats,
  userPermissionGrants,
  userRepositoryTransportCredentials,
  userSessions,
  users,
} from '@/modules/identity-access/composition/schema'
export {
  codeHostConnections,
  csEventInbox,
  csEventRoutes,
  csEventTargets,
  csWebhookVerifications,
  scheduledTasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookMrControlEffects,
  webhookMrControlTargets,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
  webhookTriggerFires,
  webhookTriggerStreams,
  webhookTriggers,
} from '@/modules/integration/composition/schema'
export {
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
  intentTurnEvents,
  intentTurns,
  intentWorkingSetChanges,
} from '@/modules/intent/composition/schema'
export { fusions } from '@/modules/knowledge-evolution/composition/schema'
export {
  memories,
  memoryDistillEvents,
  memoryDistillJobs,
  memoryScopeMoveEvents,
} from '@/modules/memory/composition/schema'
export {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/platform/committed-events/infrastructure/persistence/schema'
export { hostedObjectPublications } from '@/platform/content/infrastructure/persistence/schema'
export {
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
} from '@/modules/resource-catalog/composition/schema'
export {
  observationCallModels,
  observationCalls,
  observationPrices,
} from '@/modules/run-observability/composition/schema'
export { runtimes } from '@/modules/runtime-management/composition/schema'
export {
  cachedRepos,
  hostedTaskWorkspaces,
  hostedWorkspaceCommands,
  repoGroupNodes,
  repoGroups,
  repositoryTransportConnections,
  scPreparationOperations,
  scRepositorySnapshots,
  scRepositorySources,
} from '@/modules/source-control/composition/schema'
export {
  applicationConfiguration,
  hostedDatabaseBackups,
  hostedExecutionControl,
  lifecycleAlerts,
  lifecycleRepairAudit,
  maintenanceRuns,
  maintenanceState,
  recoveryEvents,
} from '@/modules/system-operations/composition/schema'
export {
  hostedExecutionBindings,
  hostedExecutionEvents,
  hostedTaskArtifacts,
  hostedTaskArchiveEntries,
  hostedNodeEventArchives,
  nodeExecutionEventSources,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  nodeRunSeqAllocations,
  hostedRecoveryRequests,
  reactionExecutionAdmissions,
  runtimeSessionLeases,
  taskArchiveAudit,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
  taskNodeClarifyDirectives,
  taskRepos,
  taskWorkspacePreparations,
  taskSpaceNodes,
  tasks,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
  workgroupTaskState,
} from '@/modules/task-execution/composition/schema'
