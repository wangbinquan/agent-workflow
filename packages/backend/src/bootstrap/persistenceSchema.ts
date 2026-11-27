import { persistenceHead, persistenceHistory, persistenceCatalogCache } from './persistenceHead'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import type { SchemaHistoryRuntime } from '@/platform/persistence/schema/history/runtime'
// RFC-395 activation: the single live epoch-2 registry.
import {
  schemaContribution as contribution0,
  historySchemaContribution as contribution1,
} from '@/modules/code-capability/composition/schema'

import { schemaContribution as contribution2 } from '@/modules/collaboration/composition/schema'
import { schemaContribution as contribution3 } from '@/modules/development-automation/composition/schema'
import { schemaContribution as contribution4 } from '@/modules/digital-employee/composition/schema'
import { schemaContribution as contribution5 } from '@/modules/event-center/composition/schema'
import { schemaContribution as contribution6 } from '@/modules/identity-access/composition/schema'
import { schemaContribution as contribution7 } from '@/modules/integration/composition/schema'
import { schemaContribution as contribution8 } from '@/modules/intent/composition/schema'
import { schemaContribution as contribution9 } from '@/modules/knowledge-evolution/composition/schema'
import { schemaContribution as contribution10 } from '@/modules/memory/composition/schema'
import { schemaContribution as contributionAtomicApply } from '@/platform/atomic-apply/composition/schema'
import { schemaContribution as contribution11 } from '@/platform/committed-events/composition/schema'
import { schemaContribution as contribution12 } from '@/platform/content/composition/schema'
import { schemaContribution as contribution13 } from '@/modules/resource-catalog/composition/schema'
import { schemaContribution as contribution14 } from '@/modules/run-observability/composition/schema'
import { schemaContribution as contribution15 } from '@/modules/runtime-management/composition/schema'
import { schemaContribution as contribution16 } from '@/modules/source-control/composition/schema'
import { schemaContribution as contribution17 } from '@/modules/system-operations/composition/schema'
import { schemaContribution as contribution18 } from '@/modules/task-execution/composition/schema'
import type { RuntimeSchemaBinding } from '@/platform/persistence/schema/tables'
import { materializeTableSets } from '@/platform/persistence/schema/nativeTables'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { projectLogicalSchemaContract } from '@/platform/persistence/schema/logicalContract'
import { compileContract } from '@/platform/persistence/schema/contract'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'
import { compileSchemaRowRuleCodes } from '@/platform/persistence/schema/rowRules'

export const persistenceSchema = createSchemaRegistry(
  [
    {
      ...contribution0,
      indexUniqueNulls: [
        {
          table: 'capability_templates',
          index: 'capability_templates_owner_name_unique',
          nulls: 'distinct' as const,
        },
      ],
    },
    contribution1,
    {
      ...contribution2,
      indexUniqueNulls: [
        {
          table: 'collaboration_gate_operations',
          index: 'idx_collaboration_gate_operations_revision',
          nulls: 'distinct' as const,
        },
      ],
    },
    {
      ...contribution3,
      indexUniqueNulls: [
        {
          table: 'action_templates',
          index: 'action_templates_owner_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'automation_policies',
          index: 'automation_policies_owner_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'development_adapter_definitions',
          index: 'development_adapter_definitions_owner_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'digital_employees',
          index: 'digital_employees_owner_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'repository_employee_assignments',
          index: 'repository_employee_assignments_scope_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'verification_profiles',
          index: 'verification_profiles_owner_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'development_mission_links',
          index: 'dev_mission_links_child_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'development_missions',
          index: 'development_missions_launch_idem_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'mission_input_uploads',
          index: 'mission_input_uploads_idem_unique',
          nulls: 'distinct' as const,
        },
      ],
    },
    {
      ...contribution4,
      indexUniqueNulls: [
        {
          table: 'employee_definitions',
          index: 'employee_definitions_owner_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'employee_job_templates',
          index: 'employee_job_templates_owner_type_name_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'employee_approval_sagas',
          index: 'employee_approval_sagas_correlation_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'employee_input_uploads',
          index: 'employee_input_uploads_actor_idempotency_unique',
          nulls: 'distinct' as const,
        },
        {
          table: 'employee_reaction_rounds',
          index: 'employee_reaction_rounds_inbox_unique',
          nulls: 'distinct' as const,
        },
      ],
    },
    {
      ...contribution5,
      indexUniqueNulls: [
        {
          table: 'event_subscriptions',
          index: 'event_subscriptions_active_identity_unique',
          nulls: 'distinct' as const,
        },
      ],
    },
    contribution6,
    {
      ...contribution7,
      indexUniqueNulls: [
        {
          table: 'webhook_deliveries',
          index: 'idx_webhook_deliveries_dedupe',
          nulls: 'distinct' as const,
        },
        {
          table: 'webhook_deliveries',
          index: 'idx_webhook_deliveries_mr_fact',
          nulls: 'distinct' as const,
        },
      ],
    },
    {
      ...contribution8,
      indexUniqueNulls: [
        {
          table: 'intent_turns',
          index: 'uniq_intent_turns_session_mutation',
          nulls: 'distinct' as const,
        },
      ],
    },
    contribution9,
    contribution10,
    // RFC-401 T4：AtomicApply 的持久 claim / lease / fencing（epoch-2 history 0001）。
    contributionAtomicApply,
    contribution11,
    contribution12,
    {
      ...contribution13,
      indexUniqueNulls: [
        { table: 'agents', index: 'agents_owner_name_unique', nulls: 'distinct' as const },
        { table: 'mcps', index: 'mcps_owner_name_unique', nulls: 'distinct' as const },
        { table: 'plugins', index: 'plugins_owner_name_unique', nulls: 'distinct' as const },
        { table: 'skills', index: 'skills_owner_name_unique', nulls: 'distinct' as const },
        { table: 'workgroups', index: 'workgroups_owner_name_unique', nulls: 'distinct' as const },
        {
          table: 'mcp_runtime_test_events',
          index: 'uniq_mcp_runtime_test_events_external',
          nulls: 'distinct' as const,
        },
      ],
    },
    contribution14,
    contribution15,
    {
      ...contribution16,
      indexUniqueNulls: [
        { table: 'repo_group_nodes', index: 'idx_rgn_path_ci', nulls: 'distinct' as const },
        { table: 'repo_groups', index: 'idx_repo_groups_name_ci', nulls: 'distinct' as const },
        {
          table: 'hosted_task_workspaces',
          index: 'hosted_task_workspaces_business_task_unique',
          nulls: 'distinct' as const,
        },
      ],
    },
    contribution17,
    {
      ...contribution18,
      indexUniqueNulls: [
        {
          table: 'task_space_nodes',
          index: 'idx_task_space_nodes_path_ci',
          nulls: 'distinct' as const,
        },
        {
          table: 'task_execution_lineage_operation_records',
          index: 'idx_task_execution_lineage_decision',
          nulls: 'distinct' as const,
        },
      ],
    },
  ],
  { schemaEpoch: 2 },
)
export const nativeTableSets = materializeTableSets(persistenceSchema)
declare module '@/platform/persistence/schema/tables' {
  interface SchemaBinding {
    readonly definitions: typeof persistenceSchema.tables
    readonly nativeTables: typeof nativeTableSets
  }
}
export const rowRuleCodes = compileSchemaRowRuleCodes(persistenceSchema)
/** RFC-549: the binary's own schema history — head, lineage, PostgreSQL catalogs and the epoch-2 meta tables. */
const embeddedSchemaHistory: SchemaHistoryRuntime = Object.freeze({
  head: () => persistenceHead(),
  history: () => persistenceHistory(),
  catalogCache: persistenceCatalogCache,
  metaTables: EPOCH2_META_TABLES,
})
let schemaHistorySource: SchemaHistoryRuntime = embeddedSchemaHistory
/** RFC-549: the binding's history reads through to the current source, so a successor boot reaches every reader. */
const persistenceSchemaHistory: SchemaHistoryRuntime = Object.freeze({
  get head() {
    return schemaHistorySource.head
  },
  get metaTables() {
    return schemaHistorySource.metaTables
  },
  get history() {
    return schemaHistorySource.history
  },
  get catalogCache() {
    return schemaHistorySource.catalogCache
  },
})
/**
 * RFC-549: boot this process as a successor binary. The e2e “next version” fixtures, and the in-process cases that go
 * through bootstrap-composed paths, swap the head and lineage before the daemon reads them; what is not given stays.
 * `next` receives the source being replaced (not the binding's read-through view, which would read the new source
 * back). Returns the swap-back. Production code never calls it (the RFC-549 guard locks that).
 */
export function substitutePersistenceSchemaHistory(
  next: (previous: SchemaHistoryRuntime) => Partial<SchemaHistoryRuntime>,
): () => void {
  const previous = schemaHistorySource
  schemaHistorySource = Object.freeze({ ...previous, ...next(previous) })
  return () => {
    schemaHistorySource = previous
  }
}
/** RFC-545: the live schema binding, handed explicitly to provider construction (platform never reads it from module state). */
export const persistenceSchemaBinding: RuntimeSchemaBinding = Object.freeze({
  definitions: persistenceSchema.tables,
  nativeTables: nativeTableSets,
  rowRuleCodes,
  history: persistenceSchemaHistory,
})
export const logicalSchemaContract = projectLogicalSchemaContract(persistenceSchema)
export const schemaContract = compileContract(persistenceSchema)
export const sqlitePlan = compileSqlitePlan(persistenceSchema)
export const postgresqlPlan = compilePostgresqlPlan(persistenceSchema)

export const {
  capabilityTemplates,
  repoCapabilityConfig,
  codeHistoryArchives,
  codeHistoryIdIndex,
  codeHistoryQueryStates,
  codeHistoryQueryBuilds,
  codeHistoryQueryRecords,
  codeHistoryQueryWorkItems,
  codeHistoryQueryRounds,
  codeHistoryQueryStages,
  codeHistoryQueryAttempts,
  codeHistoryQueryDeliveries,
  codeHistoryMetricTotals,
  codeHistoryMetricPrefixes,
  reviewNodeReviewers,
  taskFeedback,
  taskQuestions,
  clarifyRounds,
  clarifyAnswers,
  clarifyAnswerDrafts,
  clarifyAnswerAttributions,
  collaborationGateOperations,
  taskCollaborators,
  docVersions,
  reviewComments,
  collaborationGateArtifacts,
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
  developmentMrClaims,
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
  developmentMissions,
  developmentObjectArtifacts,
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
  employeeReactionDispatch,
  employeeReactionRounds,
  employeeRoundWorkspaceStates,
  employeeToolRegistrationRevisions,
  employeeToolRegistrations,
  employeeTypePackages,
  employeeWorkScopeRevisions,
  employeeReactionArtifacts,
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
  authLoginPolicy,
  externalIdentities,
  oidcProviders,
  resourceGrants,
  tokenAudit,
  tokenDeleteSnapshot,
  userIdentities,
  userPats,
  userPermissionGrants,
  userRepositoryTransportCredentials,
  userSessions,
  users,
  userAccessAudit,
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
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
  intentTurns,
  intentWorkingSetChanges,
  intentApplyJournal,
  intentTurnEvents,
  fusions,
  memoryDistillEvents,
  memoryDistillJobs,
  memoryScopeMoveEvents,
  memories,
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEvents,
  committedEventFamilyCutovers,
  contentObjects,
  contentBytes,
  contentPublications,
  mcpProbes,
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessionLeases,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  mcps,
  pluginArtifactGenerations,
  plugins,
  skillOperationLocks,
  skillOperations,
  workgroupMembers,
  workgroups,
  resourceBundleApplies,
  agents,
  agentSkillRefs,
  agentMcpRefs,
  agentPluginRefs,
  agentDependencies,
  workflows,
  workflowDependencyIndex,
  skills,
  skillVersions,
  skillContentEntries,
  observationCallModels,
  observationCalls,
  observationPrices,
  observationOperations,
  observationInsightAnalyses,
  runtimes,
  cachedRepos,
  hostedTaskWorkspaces,
  hostedWorkspaceCommands,
  repoGroups,
  repositoryTransportConnections,
  scPreparationOperations,
  scRepositorySnapshots,
  scRepositorySources,
  repoGroupNodes,
  applicationConfiguration,
  hostedDatabaseBackups,
  hostedExecutionControl,
  lifecycleAlerts,
  lifecycleRepairAudit,
  maintenanceRuns,
  maintenanceState,
  recoveryEvents,
  hostedExecutionBindings,
  hostedExecutionEvents,
  nodeExecutionEventSources,
  nodeRunEvents,
  nodeRunSeqAllocations,
  hostedRecoveryRequests,
  reactionExecutionAdmissions,
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
  taskWorkspacePreparations,
  taskSpaceNodes,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
  tasks,
  taskDefinitions,
  taskLaunchContexts,
  taskWorkspaces,
  taskRepositoryMounts,
  taskExecutionGenerations,
  nodeRuns,
  nodeRunSelections,
  nodeRunInputs,
  nodeRunConfigs,
  nodeRunRuntimeStates,
  nodeRunResults,
  nodeRunRepoCheckpoints,
  executionLegacyEvidence,
  workgroupTaskState,
  runtimeSessionLeases,
  nodeRunOutputs,
  hostedTaskArtifacts,
  hostedNodeEventArchives,
  hostedTaskArchiveEntries,
  hostedTaskArchiveEntryParts,
} = nativeTableSets.sqlite

export { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
