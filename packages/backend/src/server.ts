// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { Hono } from 'hono'
import type {
  AclResourceType,
  DatabaseConfig,
  DatabaseRuntimeTelemetry,
  MaintenanceStatus,
  ResourceAccess,
  ResourceAcl,
  UpdateResourceAclBody,
  WorkflowRevision,
} from '@agent-workflow/shared'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { actorOf, tryActorOf, type Actor } from '@/auth/actor'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import {
  createPostgresqlAuthRuntime,
  createPostgresqlTokenCallAudit,
  createSqliteAuthRuntime,
  createSqliteTokenCallAudit,
} from '@/auth/composition'
import {
  ALWAYS_WRITABLE_DATABASE_SOURCE,
  type DatabaseSourceWriteWindow,
} from '@/auth/application/authPersistence'
import type { SecretBox } from '@/auth/secretBox'
import { admitDaemonIdentity, multiAuth } from '@/auth/session'
import { listTokenAudit, listTokenAuditForUser, takeDeleteSnapshot } from '@/services/tokenAudit'
import { assertRouteMetaCoverage, registerRoute } from '@/routes/registry'
import type { DbClient } from '@/db/client'
import { developmentMissions, developmentMrClaims } from '@/db/schema'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { buildScheduleLaunch } from '@/services/scheduleLaunch'
import type { SmokeOptions, SmokeResult } from '@/services/runtimeSmoke'
import { getEmbeddedFrontendResponse, IS_EMBEDDED } from '@/embed'
import { mountMcpTransport } from '@/mcp/server'
import { assertOperationCatalogClosed, registerOperationAlias } from '@/platform/operations/catalog'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import {
  directMcpOperationAuthority,
  directOperationAuthority,
  directRequestAuthority,
} from '@/routes/operationAuthority'
import { mountAgentRoutes } from '@/routes/agents'
import { mountAuthRoutes } from '@/routes/auth'
import { mountBackupRoutes } from '@/routes/backup'
import { mountDatabaseMigrationRoutes } from '@/routes/databaseMigrations'
import { mountRestoreRoutes } from '@/routes/restore'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import { mountRepoGroupRoutes } from '@/routes/repoGroups'
import { mountConfigRoutes, type ConfigConcurrencyHotApplyCommand } from '@/routes/config'
import { mountDaemonRoutes } from '@/routes/daemon'
import { mountDocsRoutes, mountWellKnownRoutes } from '@/routes/docs'
import { mountHealthRoutes } from '@/routes/health'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import {
  supportsEventCenterCodeHostDelivery,
  supportsEventCenterWorkStart,
  type WebhookDispatcher,
} from '@/services/webhook/dispatcherTypes'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import {
  createIdentityAccessRuntime,
  createPostgresqlIdentityAccessRuntime,
  type IdentityAccessModule,
  type IdentityAccessRuntime,
  type PostgresqlIdentityAccessCrossContextBindings,
} from '@/modules/identity-access/composition'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeAgentCatalog } from '@/modules/resource-catalog/composition/agentOperations'
import { composeSqliteAgentImportQueries } from '@/modules/resource-catalog/composition/agentImportQueries'
import { composeSqliteAgentResourceIntegrity } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { composeMcpCatalog } from '@/modules/resource-catalog/composition/mcpOperations'
import { composeSqliteMcpProbeStore } from '@/modules/resource-catalog/composition/mcpProbeStore'
import { composeSqliteMcpRuntimeTestProvider } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composePluginCatalog } from '@/modules/resource-catalog/composition/pluginOperations'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import { composeWorkflowCatalog } from '@/modules/resource-catalog/composition/workflowOperations'
import { composeWorkgroupCatalog } from '@/modules/resource-catalog/composition/workgroupOperations'
import { composeSqliteWorkgroupTaskRoom } from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import { composeSqliteDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import {
  composeSqliteResourceCatalog,
  type ProviderResourceCatalogComposition,
} from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  composeResourcePackageOperations,
  composeSqliteResourcePackageProvider,
  type ComposedResourcePackageCatalog,
} from '@/modules/resource-catalog/composition/resourcePackageOperations'
import { composeSqliteDynamicWorkflowValidationContext } from '@/modules/resource-catalog/composition/workflowOperations'
import { composeIntentApplyResourceBinding } from '@/modules/resource-catalog/composition/intentApply'
import {
  canViewResource,
  canViewResourceInTx,
  composeResourceScopeAuthorizationBinding,
  filterVisibleRows,
  getResourceAcl,
  requireResourceEdit,
  requireResourceGovern,
  updateResourceAcl,
  type ResourceScopeAuthorizationBinding,
} from '@/modules/resource-catalog/composition/resourceAcl'
import { assertNameUnchangedForEditor } from '@/modules/resource-catalog/application/resourceAccess'
import { resourceAclAudienceAuthority } from '@/modules/resource-catalog/domain/resourceAccess'
import {
  composeIntegrationTriggerResourceBinding,
  type IntegrationTriggerResourceBinding,
} from '@/modules/resource-catalog/composition/integrationTrigger'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type {
  AgentCatalogModule,
  McpCatalogModule,
  PluginCatalogModule,
  SkillCatalogModule,
  WorkflowCatalogModule,
  WorkgroupCatalogModule,
} from '@/modules/resource-catalog/public/operations'
import {
  composePostgresqlSystemOperations,
  composeSystemOperations,
  type PostgresqlSystemOperationsModule,
  type SystemOperationsModule,
} from '@/modules/system-operations/composition'
import {
  composePostgresqlMaintenanceDiskOperations,
  composeSqliteMaintenanceDiskOperations,
} from '@/modules/system-operations/composition/maintenanceDisk'
import type { MaintenanceDiskOperations } from '@/modules/system-operations/public/operations'
import type { DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { SYSTEM_OPERATION_ALIASES } from '@/modules/system-operations/public/operations'
import type { HealthDatabaseReadModel } from '@/modules/system-operations/public/queries'
import { createPostgresqlHealthDatabaseReadModel } from '@/modules/system-operations/composition'
import { createSqliteHealthDatabaseReadModel } from '@/platform/persistence/sqlite/systemHealthReadModel'
import { composeSqliteOidcIdentityOperations } from '@/modules/identity-access/composition/providerOperations'
import type { IdentityUserOperations } from '@/modules/identity-access/public/operations'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { createOidcProvidersService } from '@/services/oidcProviders'
import { getMcpRuntimeTestService, type McpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { getProbeByMcpId } from '@/services/mcpProbeStore'
import {
  mcpOperationCoordinator,
  pluginOperationCoordinator,
} from '@/services/resourceOperationCoordinator'
import {
  deletePreparedMcpRuntimeTestsInTx,
  transitionMcpRuntimeTestsInTx,
} from '@/services/mcpRuntimeTestTransitions'
import { mcpRouteNow, mountMcpRoutes } from '@/routes/mcps'
import { mountMemoryRoutes } from '@/routes/memories'
import { mountMemoryDistillJobRoutes } from '@/routes/memoryDistillJobs'
import {
  composeSqliteMemoryCatalogOperations,
  composeSqliteMemoryInjectionQueries,
  composeSqliteMemoryOperations,
} from '@/modules/memory/composition'
import { composeSqliteFusionOperations } from '@/modules/knowledge-evolution/composition/fusion'
import { createSqliteFusionEngineTaskOperations } from '@/modules/task-execution/infrastructure/fusionEngineTaskOperations'
import { createSqliteTaskRouteOperations } from '@/modules/task-execution/infrastructure/sqliteTaskRouteOperations'
import type { MemoryOperations } from '@/modules/memory/public/operations'
import type { MemoryDistillCommands } from '@/modules/memory/public/commands'
import type { MemoryDistillQueries } from '@/modules/memory/public/queries'
import {
  readCommittedReviewArtifactBody,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { mountTaskFeedbackRoutes } from '@/routes/taskFeedback'
import { mountOverviewRoutes, type OverviewRouteQuery } from '@/routes/overview'
import { buildOverview } from '@/services/overview'
import { mountOidcRoutes } from '@/routes/oidc'
import { mountOidcAuthRoutes } from '@/routes/oidc-auth'
import { mountPlantumlRoutes } from '@/routes/plantuml'
import { mountPluginRoutes } from '@/routes/plugins'
import { mountUserRoutes } from '@/routes/users'
import { mountRepoRoutes } from '@/routes/repos'
import { mountRuntimeRoutes } from '@/routes/runtime'
import { mountRuntimesRoutes } from '@/routes/runtimes'
import { mountSkillRoutes } from '@/routes/skills'
import { mountClarifyRoutes } from '@/routes/clarify'
import { mountTaskQuestionRoutes } from '@/routes/taskQuestions'
import { mountTaskClarifyDirectiveRoutes } from '@/routes/taskClarifyDirective'
import { mountFusionRoutes } from '@/routes/fusions'
import {
  mountIntentSessionRoutes,
  type IntentSessionRouteDependencies,
} from '@/routes/intentSessions'
import { legacyIntentApplyResourceDependencies } from '@/services/intent/legacyIntentApplyResourceDependencies'
import {
  composeSqliteIntentApplyOperations,
  createSqliteIntentApplyArtifactLifecycle,
} from '@/modules/intent/composition/apply'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '@/modules/intent/composition/auxiliaryQueries'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import { composeSqliteIntentPersistence } from '@/modules/intent/composition/persistence'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '@/modules/resource-catalog/composition/intentContextAuthorization'
import type { IntentApplyOperations } from '@/modules/intent/public/operations'
import { composeIntentResourceCatalogFor } from '@/services/intent/resourceCatalog'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { mountReviewRoutes } from '@/routes/reviews'
import { mountMaintenanceDiskRoutes } from '@/routes/maintenanceDisk'
import { mountMaintenanceRoutes } from '@/routes/maintenance'
import { mountTaskArchiveRoutes } from '@/routes/taskArchive'
import { mountTaskRoutes } from '@/routes/tasks'
import { mountTaskCatalogRoutes } from '@/routes/taskCatalog'
import { mountScheduledTaskRoutes } from '@/routes/scheduledTasks'
import { mountCodeHostRoutes } from '@/routes/codeHosts'
import { mountAccountRepositoryTransportCredentialRoutes } from '@/routes/accountRepositoryTransportCredentials'
import {
  mountCapabilityTemplateRoutes,
  type CapabilityTemplateRouteDeps,
} from '@/routes/capabilityTemplates'
import {
  mountDevelopmentConfigRoutes,
  type DevelopmentConfigAclRouteBinding,
} from '@/routes/developmentConfig'
import { mountDevelopmentMissionRoutes } from '@/routes/developmentMissions'
import {
  mountDigitalEmployeeRoutes,
  type DigitalEmployeeAclResourceType,
  type DigitalEmployeeRoutePersistence,
} from '@/routes/digitalEmployees'
import { mountEventCenterRoutes } from '@/routes/eventCenter'
import { mountExecutionContractRoutes } from '@/routes/executionContracts'
import { mountMissionInputUploadRoutes } from '@/routes/missionInputUploads'
import { mountCodeRoutes, type CodeHistoryRouteQueries } from '@/routes/code'
import { mountWebhookEndpointRoutes } from '@/routes/webhookEndpoints'
import { mountWebhookTriggerRoutes } from '@/routes/webhookTriggers'
import { mountWebhookDeliveryRoutes } from '@/routes/webhookDeliveries'
import { mountWorkflowRoutes } from '@/routes/workflows'
import { mountWorkgroupRoutes } from '@/routes/workgroups'
import { registerResourcePackageRoutes } from '@/routes/resourcePackages'
import { Paths } from '@/util/paths'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountWorktreeFilesRoutes, type WorktreeFilesRouteDeps } from '@/routes/worktree-files'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import { mountPortArtifactRoutes } from '@/routes/port-artifacts'
import { errorHandler, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { loadConfig } from '@/config'
import { createLogger } from '@/util/log'
import {
  composeDigitalEmployee,
  composeDigitalEmployeeAgentTemplateCatalogParticipant,
  composeDigitalEmployeePlatformInventoryParticipant,
  composeDigitalEmployeeIntegrationTriggerParticipant,
  composeDigitalEmployeeTaskCatalogSource,
  composeSqliteDigitalEmployeeWriterCutover,
  createEmployeeInputArtifactStore,
  createReactionExecutionAdapter,
} from '@/modules/digital-employee/composition'
import { assertNotBuiltin } from '@/services/systemResources'
import { legacyTaskExecutionResourceDependencies } from '@/services/execution/legacyTaskExecutionResourceDependencies'
import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/public/participants'
import { createDigitalEmployeeResourceCatalogAclProviders } from '@/modules/digital-employee/composition'
import type {
  DigitalEmployeePlatformToolCatalogParticipant,
  EmployeeCaseDetailProjectionParticipant,
} from '@/modules/digital-employee/public/types'
import {
  developmentExecutionContractRegistrations,
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeDevelopmentConfigOperations,
  type DevelopmentConfigAccessRow,
  type DevelopmentConfigResourceAccess,
} from '@/modules/development-automation/composition/configOperations'
import {
  composeDevelopmentMissionOperations,
  createLegacyMissionAdmissionsEnabledQuery,
} from '@/modules/development-automation/composition/missionOperations'
import { composeSqliteMissionInputUploadOperations } from '@/modules/development-automation/composition/missionInputUploads'
import { composeSqliteCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import {
  composeSqliteCapabilityTemplateOperations,
  createSqliteCapabilityTemplatePersistence,
} from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { composeSqliteLegacyCodeReadProviders } from '@/modules/code-capability/composition/legacyCodeReads'
import {
  createDevelopmentActivityWorkerBinding,
  type DevelopmentActivityWorkerBinding,
} from '@/modules/development-automation/composition/activityOperations'
import type {
  DevelopmentActivityOperations,
  DevelopmentConfigOperations,
  DevelopmentMissionOperations,
} from '@/modules/development-automation/public/operations'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import {
  composeEventCenter,
  deferEventCenterModule,
  type EventCenterModule,
} from '@/modules/event-center/composition'
import { composeDigitalEmployeeExecution } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  composeTaskClarifyDirectiveRouteOperations,
  composeTaskExecutionRuntime,
  createSqliteTaskExecutionPersistence,
} from '@/modules/task-execution/composition/taskExecutionRuntime'
import { createSqliteTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots'
import { createSqliteTaskExecutionRuntimeParticipants } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants'
import { createSqliteRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'
import { createSqliteTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { composeSqliteAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { createSqliteTaskRouteLaunchOperations } from '@/modules/task-execution/composition/taskRouteLaunch'
import {
  composePostgresqlRuntimeRegistryOperations,
  composeSqliteRuntimeRegistryOperations,
} from '@/platform/runtime-registry/composition'
import type { RuntimeRegistryOperations } from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import {
  requireSchedulerDriver,
  type SchedulerDriverPort,
} from '@/modules/task-execution/public/commands'
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'
import {
  createCollaborationCommandContext,
  createSqliteCollaborationTaskAccessPort,
  planMembersReplacement,
} from '@/modules/collaboration/composition'
import {
  createSqliteClarifyDecisionCommand,
  createSqliteQuestionDispatchCommand,
  createSqliteReviewDecisionCommand,
} from '@/modules/collaboration/composition/legacySqliteDecisionCommands'
import { composeSqliteCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import { createSqliteCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/sqliteCollaborationRuntimeMechanics'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import { composeTaskExecutionCatalogSources } from '@/modules/task-execution/composition/sqliteTaskCatalogSources'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { assertWorkflowSnapshotLaunchable } from '@/services/taskLaunchGate'
import { createSqliteResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { setChildTaskBudgetCapacity } from '@/services/execution/childBudget'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { listDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import {
  composeSqliteDevelopmentEmployeeWorkspace,
  createSqliteDevelopmentEmployeeCaseWorkspaceDetailReader,
} from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeSqliteDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeCaseDetailProjection } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import {
  composeDevelopmentAutomation,
  composeSqliteDevelopmentAdmissionLookup,
  createSqliteDevelopmentMissionExecutionTerminalObserver,
  createSqliteDevelopmentDeliveryProvider,
  createSqliteMissionCodeHostEventContinuation,
  type DevelopmentAdmissionLookup,
  type DevelopmentAutomationModule,
} from '@/modules/development-automation/composition'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentMrFactsDeps,
  buildDevelopmentPipelineDeps,
  createDevelopmentWorkspaceRepositoryPreparation,
  resolveDevelopmentRepoBinding,
  type DevelopmentDeliveryProvider,
} from '@/services/developmentDeliveryDeps'
import {
  composeDevelopmentApprovalEventObserver,
  composeDevelopmentCodeHostEventObserver,
  composeDevelopmentEmployeeEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import { composeSqliteApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeSqliteScheduledTaskRuntime } from '@/modules/integration/composition/scheduledTasks'
import { composeSqliteWebhookEndpointServiceDependencies } from '@/modules/integration/composition/webhookEndpoints'
import { composeSqliteWebhookTriggerServiceDependencies } from '@/modules/integration/composition/webhookDispatch'
import { composeSqlitePipelineEvidenceRunner } from '@/modules/integration/composition/pipelineEvidence'
import { composeDevelopmentAdapterConfigOperations } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { composeSqliteRequirementSourceRunner } from '@/modules/integration/composition/requirementSource'
import { composeSqliteDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import {
  createCodeHostWebhookDeliveryConsumer,
  createCodeHostWebhookRoutingDirectory,
  createRepositoryEndpointDiscovery,
} from '@/modules/integration/composition'
import {
  composeSqliteWebhookDeliveryRuntime,
  composeSqliteWebhookIngressPersistence,
  type WebhookIngressPersistence,
} from '@/modules/integration/composition/webhookIngress'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import type { DeferredDigitalEmployeeWorkStart } from '@/modules/integration/composition'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import { canManageCaseMembers } from '@/services/employeeCaseMembers'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  composePostgresqlRepositoryWorkspaceStore,
  composeRepositoryWorkspaceOperations,
  composeRepositoryTransportCredentials,
  composeSqliteRepositoryWorkspaceStore,
  createRepositoryPublicationTransport,
  PostgresqlRepositoryTransportCredentialRepository,
  reconcileRepositoryTransportConnectionProjections,
  SQLiteRepositoryTransportCredentialRepository,
  type RepositoryTransportCredentialModule,
  type RepositoryTransportCredentialRepository,
  type RepositoryWorkspaceOperations,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import {
  composePostgresqlRealtimeRuntime,
  composeSqliteRealtimeRuntime,
  type RealtimeCompositionPolicy,
} from '@/modules/runtime-management/composition'
import type { RealtimeRuntime } from '@/modules/runtime-management/public/participants'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { createCodeHostConnectionsService } from '@/services/codeHost/connections'
import { unsealRepoUrl } from '@/services/repoCredentials'

/**
 * Narrow in-process dependency seams for route tests that exercise diagnostics
 * with deterministic fixture executables. Production startup never supplies
 * these; there is no config, environment, or HTTP switch that can select them.
 */
export interface RuntimeDiagnosticTestDependencies {
  smokeRuntime(options: SmokeOptions): Promise<SmokeResult>
  /**
   * Deterministic finalization seam for the runtime-probe/config fence race.
   * Production never supplies it.
   */
  beforeRuntimeProbeCache?(): void | Promise<void>
  /**
   * RFC-284 T26 — per-row `--version` probe timeout for /api/runtimes/status.
   * Test-only injection（取代已删除的同名 env 通道，见 docs/env-flags.md
   * §已删除）；production keeps the 5s default.
   */
  probeTimeoutMsForTest?: number
}

/** Bootstrap event sink shared by both database-provider compositions. */
export interface DaemonIdentityAccessEventSink {
  authorityRevisionChanged(input: {
    readonly userId: string
    readonly revision: number
    readonly onFailure: (error: unknown) => void
  }): void
}

/** Bootstrap presence sink shared by both database-provider compositions. */
export interface DaemonPresenceProjectionSink {
  publish(changes: ReadonlyArray<{ readonly userId: string; readonly online: boolean }>): void
}

type SqliteAuthRevalidation = NonNullable<
  Parameters<typeof createSqliteAuthRuntime>[0]['revalidate']
>

export type DaemonCredentialRevocationReason = Parameters<SqliteAuthRevalidation>[0]

interface DaemonProviderCoreCommonInput {
  readonly appHome: string
  readonly secretBox: SecretBox | undefined
  /**
   * RFC-349 T10 — false while a migration has frozen the selected source. Only
   * daemon bootstrap supplies one; everything else stays always-writable.
   */
  readonly sourceWriteWindow?: DatabaseSourceWriteWindow
  readonly realtimePolicy: RealtimeCompositionPolicy
  readonly onCredentialRevoked: (reason: DaemonCredentialRevocationReason) => void
  readonly identityEvents: DaemonIdentityAccessEventSink
  readonly presenceProjection: DaemonPresenceProjectionSink
  readonly identityId?: () => string
  readonly now?: () => number
}

export interface ComposeSqliteDaemonProviderCoreInput extends DaemonProviderCoreCommonInput {
  readonly db: DbClient
  readonly dbPath: string
  readonly lockPath: string
  readonly resolveRestoreMigrations?: () => Promise<string>
}

export interface ComposePostgresqlDaemonProviderCoreInput extends DaemonProviderCoreCommonInput {
  readonly db: PostgresqlDatabaseClient
  readonly runtime: PostgresqlDatabaseRuntime
  readonly databaseConfig: Extract<DatabaseConfig, { provider: 'postgresql' }>
  readonly identityCrossContext: PostgresqlIdentityAccessCrossContextBindings
  readonly lockPath: string
  readonly contract?: LogicalSchemaContract
  readonly plan?: PostgresqlSchemaPlan
}

/**
 * Closed provider bundle consumed by all daemon transports. Database handles
 * remain captured by the provider adapters and never cross into route mount.
 */
export interface DaemonProviderCore<
  TSystemOperations extends SystemOperationsModule = SystemOperationsModule,
> {
  readonly provider: DatabaseProvider
  readonly authRuntime: AuthRuntime
  readonly tokenCallAudit: TokenCallAuditParticipant
  /** The one window both the auth runtime and the token-call audit consult. */
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly identityAccess: IdentityAccessRuntime
  readonly healthDatabase: HealthDatabaseReadModel
  readonly runtimeRegistry: RuntimeRegistryOperations
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  readonly repositoryWorkspaceOperations: RepositoryWorkspaceOperations
  readonly repositoryTransportCredentialRepository: RepositoryTransportCredentialRepository
  readonly realtime: RealtimeRuntime
  readonly systemOperations: TSystemOperations
  readonly maintenanceDisk: MaintenanceDiskOperations
}

function daemonIdentityOptions(input: DaemonProviderCoreCommonInput) {
  return {
    events: input.identityEvents,
    presenceProjection: input.presenceProjection,
    ...(input.identityId === undefined ? {} : { id: input.identityId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  }
}

/** Bootstrap-only SQLite provider composition. */
export function composeSqliteDaemonProviderCore(
  input: ComposeSqliteDaemonProviderCoreInput,
): SelectedDaemonProviderCore<'sqlite'> {
  const repositoryWorkspaceStore = composeSqliteRepositoryWorkspaceStore(input.db)
  const repositoryWorkspaceOperations = composeRepositoryWorkspaceOperations(
    repositoryWorkspaceStore,
    input.secretBox,
  )
  const repositoryTransportCredentialRepository = new SQLiteRepositoryTransportCredentialRepository(
    input.db,
  )
  const sourceWriteWindow = input.sourceWriteWindow ?? ALWAYS_WRITABLE_DATABASE_SOURCE
  const authRuntime = createSqliteAuthRuntime({
    db: input.db,
    revalidate: input.onCredentialRevoked,
    sourceWriteWindow,
  })
  const identityAccess = createIdentityAccessRuntime({
    db: input.db,
    ...daemonIdentityOptions(input),
  })

  return Object.freeze({
    provider: 'sqlite',
    authRuntime,
    sourceWriteWindow,
    tokenCallAudit: createSqliteTokenCallAudit(input.db),
    identityAccess,
    healthDatabase: createSqliteHealthDatabaseReadModel(input.db),
    runtimeRegistry: composeSqliteRuntimeRegistryOperations(input.db),
    repositoryWorkspaceStore,
    repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository,
    realtime: composeSqliteRealtimeRuntime({
      db: input.db,
      auth: authRuntime,
      directAuthority: identityAccess.directAuthority,
      policy: input.realtimePolicy,
    }),
    systemOperations: composeSystemOperations({
      db: input.db,
      secretBox: input.secretBox,
      repositoryBackupPreparation: repositoryWorkspaceOperations.backupPreparation,
      appHome: input.appHome,
      dbPath: input.dbPath,
      lockPath: input.lockPath,
      ...(input.resolveRestoreMigrations === undefined
        ? {}
        : { resolveRestoreMigrations: input.resolveRestoreMigrations }),
    }),
    maintenanceDisk: composeSqliteMaintenanceDiskOperations(input.db, input.appHome),
  })
}

/** Bootstrap-only PostgreSQL provider composition. */
export function composePostgresqlDaemonProviderCore(
  input: ComposePostgresqlDaemonProviderCoreInput,
): SelectedDaemonProviderCore<'postgresql'> {
  const repositoryWorkspaceStore = composePostgresqlRepositoryWorkspaceStore(input.db)
  const repositoryWorkspaceOperations = composeRepositoryWorkspaceOperations(
    repositoryWorkspaceStore,
    input.secretBox,
  )
  const repositoryTransportCredentialRepository =
    new PostgresqlRepositoryTransportCredentialRepository(input.db)
  const sourceWriteWindow = input.sourceWriteWindow ?? ALWAYS_WRITABLE_DATABASE_SOURCE
  const authRuntime = createPostgresqlAuthRuntime({
    db: input.db,
    onCredentialRevoked: input.onCredentialRevoked,
    sourceWriteWindow,
  })
  const identityAccess = createPostgresqlIdentityAccessRuntime({
    db: input.db,
    crossContextTransactions: input.identityCrossContext,
    ...daemonIdentityOptions(input),
  })

  return Object.freeze({
    provider: 'postgresql',
    authRuntime,
    sourceWriteWindow,
    tokenCallAudit: createPostgresqlTokenCallAudit(input.db),
    identityAccess,
    healthDatabase: createPostgresqlHealthDatabaseReadModel(input.db),
    runtimeRegistry: composePostgresqlRuntimeRegistryOperations(input.db),
    repositoryWorkspaceStore,
    repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository,
    realtime: composePostgresqlRealtimeRuntime({
      db: input.db,
      auth: authRuntime,
      directAuthority: identityAccess.directAuthority,
      policy: input.realtimePolicy,
    }),
    systemOperations: composePostgresqlSystemOperations({
      runtime: input.runtime,
      databaseConfig: input.databaseConfig,
      repositoryBackupPreparation: repositoryWorkspaceOperations.backupPreparation,
      appHome: input.appHome,
      lockPath: input.lockPath,
      ...(input.contract === undefined ? {} : { contract: input.contract }),
      ...(input.plan === undefined ? {} : { plan: input.plan }),
    }),
    maintenanceDisk: composePostgresqlMaintenanceDiskOperations(input.runtime, input.appHome),
  })
}

export interface AppDeps {
  /**
   * RFC-349 bootstrap-selected provider core shared by HTTP, MCP, WebSocket
   * and background services. Individual fields below remain test seams; the
   * daemon supplies this aggregate so every consumer observes one provider.
   */
  providerCore?: DaemonProviderCore
  /** One daemon-scoped execution driver composed by server/CLI bootstrap. */
  schedulerDriver?: SchedulerDriverPort
  /** Read projections composed with the same task-execution runtime. */
  taskExecutionReadModels?: TaskExecutionReadModels
  /** Provider-selected Agent/Workgroup launch operations shared with route mounts. */
  taskRouteLaunch?: ReturnType<typeof createSqliteTaskRouteLaunchOperations>
  /**
   * RFC-321 bootstrap publication transport. Task launch/continuation topologies
   * reuse its GitHub/GitLab endpoint discovery instead of rebuilding a
   * key-file-only transport that can only apply URL rules.
   */
  repositoryPublicationTransport?: ReturnType<typeof createRepositoryPublicationTransport>
  /**
   * RFC-344 daemon-scoped development automation participant. The CLI injects
   * the same instance used by recovery and wake sweeps so REST and MCP cannot
   * create an independent orchestration root.
   */
  developmentAutomation?: DevelopmentAutomationModule
  /**
   * RFC-317 T54 —— RFC-321 传输凭据模块，**由 bootstrap 装配**后传进来。
   *
   * RFC-317 把它从当时会被 REST/MCP 两次调用的 `mountApiRoutes` 上移到
   * bootstrap。RFC-344 已删除第二套 MCP Hono；继续由 bootstrap 持有，避免
   * route mount 重新成为 module composition owner。
   *
   * `undefined`（直接调 `mountApiRoutes` 的调用方）与 `null`（没有 secretBox）
   * 都表示「没有传输凭据模块」。
   */
  repositoryTransport?: RepositoryTransportCredentialModule | null
  /** RFC-349 bootstrap-selected transport credential persistence. */
  repositoryTransportCredentialRepository?: RepositoryTransportCredentialRepository
  /** RFC-349 bootstrap-selected source-control workspace persistence. */
  repositoryWorkspaceStore?: RepositoryWorkspaceStore
  /** Token required for /api/*. */
  token: string
  /** Absolute path to config.json (lets tests use a temp file). */
  configPath: string
  /**
   * Root used for immutable digital-employee program artifacts and isolated
   * contract fixtures. Production uses Paths.root; tests may pin a dedicated
   * directory without touching the process-global Paths singleton.
   */
  appHome?: string
  /**
   * Absolute path to the daemon run-info file (host/port/url the daemon is
   * actually bound to). Optional — defaults to `Paths.daemonInfo` in the route;
   * tests inject a temp file. Read by GET /api/daemon.
   */
  daemonInfoPath?: string
  /**
   * Legacy-compatible health field. RFC-226 production startup never probes
   * optional OpenCode and therefore passes null; tests may inject a string to
   * verify compatibility with older health payloads.
   */
  opencodeVersion: string | null
  /** DB schema version (count of applied migrations). */
  dbVersion: number
  /** Legacy direct-test SQLite handle used by the compatibility wrapper. */
  db: DbClient
  /** RFC-349 bootstrap-selected authentication runtime. */
  authRuntime?: AuthRuntime
  /** RFC-349 bootstrap-selected REST/MCP/maintenance audit participant. */
  tokenCallAudit?: TokenCallAuditParticipant
  /** RFC-349 bootstrap-selected liveness projection. */
  healthDatabase?: HealthDatabaseReadModel
  /** RFC-349 bootstrap-selected backup/restore administration module. */
  systemOperations?: SystemOperationsModule
  /** RFC-349 bootstrap-selected webhook ingress persistence. */
  webhookIngressPersistence?: WebhookIngressPersistence
  /** RFC-349 bootstrap-selected runtime registry. */
  runtimeRegistry?: RuntimeRegistryOperations
  /** Daemon-scoped live concurrency mutation composed by bootstrap. */
  configConcurrencyHotApply?: ConfigConcurrencyHotApplyCommand
  /**
   * RFC-349 provider-neutral execution-contract projection. Production
   * bootstrap injects the selected provider adapter once so HTTP and the
   * Digital Employee worker share the same application participant. Direct
   * createApp tests may omit it and retain the SQLite compatibility path.
   */
  executionContracts?: ReturnType<typeof composeExecutionContract>
  /**
   * RFC-349 provider-neutral code-history projections. Production bootstrap
   * injects the selected provider aggregate once; direct createApp tests may
   * omit it and retain the SQLite compatibility composition.
   */
  codeHistoryQueries?: CodeHistoryRouteQueries
  /** Branded selected-provider Agent template catalog shared with the employee OS. */
  digitalEmployeeAgentTemplates?: DigitalEmployeeAgentTemplateCatalogParticipant
  /**
   * Completed immutable platform-tool projection. Production composes this
   * asynchronously before HTTP assembly; the synchronous direct-test wrapper
   * may omit it and exercises the empty platform catalog explicitly.
   */
  digitalEmployeePlatformTools?: DigitalEmployeePlatformToolCatalogParticipant
  /** RFC-349 bootstrap-selected admission lookup shared by reconcile and HTTP launch. */
  developmentAdmissionLookup?: DevelopmentAdmissionLookup
  /** RFC-349 provider-neutral distillation monitoring queries. */
  memoryDistillQueries?: MemoryDistillQueries
  /** RFC-349 bootstrap-selected memory command/query/worker aggregate. */
  memoryOperations?: MemoryOperations
  /**
   * RFC-349 bootstrap-owned database migration application. Production and
   * contract harnesses inject one composition root with their own admission
   * and durable paths; route mounting never constructs provider mechanisms.
   */
  databaseMigration?: DatabaseMigrationModule
  /** RFC-347 bootstrap-owned authority/presence runtime shared by HTTP/MCP/WS. */
  identityAccess?: IdentityAccessRuntime & {
    readonly taskExecutionResources?: TaskExecutionResourceBinding
  }
  /** RFC-340 bootstrap-owned review access/config context shared by REST and MCP dispatch. */
  collaborationContext?: CollaborationCommandContext
  /** RFC-338: indexed/live projection from the off-thread maintenance owner. */
  maintenanceStatus?: () => MaintenanceStatus
  /** RFC-349: selected-provider mechanism telemetry, kept separate from request latency. */
  databaseTelemetry?: () => DatabaseRuntimeTelemetry
  /**
   * RFC-036 — AES-256-GCM seal/unseal helper. Required only for the OIDC
   * routes (admin CRUD + login callback). Tests that do not exercise OIDC
   * can omit it; the OIDC routes refuse to mount without it.
   */
  secretBox?: SecretBox
  /**
   * RFC-257 — async webhook dispatch (the T6 fan-out engine). The public
   * ingress route refuses to mount without BOTH this and secretBox (same
   * self-skip discipline as OIDC) so a partially-wired app never exposes a
   * guaranteed-500 public route.
   */
  webhookDispatcher?: WebhookDispatcher
  /** RFC-303 durable launch guard + terminal effect worker. */
  webhookTerminalControl?: MrTerminalControl
  /**
   * RFC-310 OS: production shares this durable Event Center composition with
   * webhook ingress so passive code-host hints can wake the subscribed poller.
   * Route tests may omit it and use the local DB-backed composition below.
   */
  digitalEmployeeEventCenter?: EventCenterModule
  /**
   * Type-owned Case-detail projection, composed once at bootstrap so the REST
   * and MCP route tables share the same participant.
   */
  digitalEmployeeCaseDetailProjection?: EmployeeCaseDetailProjectionParticipant
  /** Bun-dev only: serve the current type-package draft without rewriting its frozen DB row. */
  digitalEmployeeTypePackageDriftPolicy?: 'reject' | 'draft-overlay'
  /** Bootstrap-local late binding that makes orchestration and Employee Case peer work targets. */
  digitalEmployeeWorkStart?: DeferredDigitalEmployeeWorkStart
  /**
   * RFC-269 — outbound `fetch` seam for code-host calls (connection tests and
   * the call-node executor). Production omits it and the real `fetch` is used;
   * tests inject a stub so no suite ever depends on reaching gitlab.com.
   */
  codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
  /**
   * RFC-159 — override the scheduled-task run-now launch closure. Production
   * omits it (the route builds the real one from db + configPath); tests inject
   * a stub so POST /:id/run-now doesn't spawn a real opencode task.
   */
  buildScheduleLaunch?: BuildScheduleLaunch
  /**
   * RFC-199 deterministic concurrency seam for exact workflow consumers.
   * Production leaves this undefined. Tests use it to commit a concurrent
   * workflow writer after the exact-revision guard and prove validation/YAML
   * serialization still consume the one captured immutable revision.
   */
  workflowExactOperationHook?: (input: {
    operation: 'validate' | 'export'
    revision: WorkflowRevision
  }) => void | Promise<void>
  /**
   * Test-only route dependency injection. Production callers must omit this;
   * the default path always invokes the registered runtime naturally.
   */
  runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticTestDependencies>
  /** RFC-234 test seam: stub the intent turn's system-agent run. */
  intentTestDependencies?: {
    runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
  /** RFC-238 test seams; production uses the real runtime runner and app home. */
  mcpRuntimeTestDependencies?: {
    runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    now?: () => number
    appHome?: string
    capacity?: number
  }
  /** RFC-349 bootstrap-selected MCP runtime-test service. */
  mcpRuntimeTests?: McpRuntimeTestService
}

/**
 * Route tables consume one already-composed task-execution runtime. Keeping
 * these fields required at the REST/MCP mount boundary makes every alternate
 * entry point (including direct dispatcher tests) choose an explicit bootstrap
 * composition instead of discovering a missing driver only on first request.
 */
type SqliteAppDeps = AppDeps & { readonly db: DbClient }

type RuntimeComposedAppDeps = SqliteAppDeps & {
  readonly authRuntime: AuthRuntime
  readonly tokenCallAudit: TokenCallAuditParticipant
  readonly healthDatabase: HealthDatabaseReadModel
  readonly systemOperations: SystemOperationsModule
  readonly maintenanceDisk: MaintenanceDiskOperations
  readonly webhookIngressPersistence: WebhookIngressPersistence
  readonly runtimeRegistry: RuntimeRegistryOperations
  readonly configConcurrencyHotApply: ConfigConcurrencyHotApplyCommand
  readonly identityAccess: IntegrationTriggerIdentityAccess
  readonly schedulerDriver: SchedulerDriverPort
  readonly taskExecutionReadModels: TaskExecutionReadModels
  readonly collaborationContext: CollaborationCommandContext
  readonly executionContracts: ReturnType<typeof composeExecutionContract>
  readonly codeHistoryQueries: CodeHistoryRouteQueries
  readonly developmentAdmissionLookup: DevelopmentAdmissionLookup
  readonly memoryDistillCommands: MemoryDistillCommands
  readonly memoryDistillQueries: MemoryDistillQueries
  readonly memoryOperations: MemoryOperations
}

export type IntegrationTriggerIdentityAccess = IdentityAccessRuntime & {
  readonly integrationTriggerResources: IntegrationTriggerResourceBinding
  readonly taskExecutionResources: TaskExecutionResourceBinding
}

function hasIntegrationTriggerResources(
  identityAccess: IdentityAccessRuntime,
): identityAccess is IntegrationTriggerIdentityAccess {
  return (
    'integrationTriggerResources' in identityAccess && 'taskExecutionResources' in identityAccess
  )
}

function withIntegrationTriggerResources(
  db: DbClient,
  identityAccess: IdentityAccessRuntime,
): IntegrationTriggerIdentityAccess {
  if (hasIntegrationTriggerResources(identityAccess)) return identityAccess
  return Object.freeze({
    ...identityAccess,
    integrationTriggerResources: composeIntegrationTriggerResourceBinding(
      { canViewResourceInTx, assertNotBuiltin },
      composeDigitalEmployeeIntegrationTriggerParticipant,
    ),
    taskExecutionResources: createSqliteTaskExecutionResourceBinding(
      db,
      composeTaskExecutionResourceBinding(legacyTaskExecutionResourceDependencies),
    ),
  })
}

interface RepositoryBootstrap {
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  readonly repositoryWorkspaceOperations: RepositoryWorkspaceOperations
  readonly repositoryTransport: RepositoryTransportCredentialModule | null
  readonly codeHostConnections: ReturnType<typeof createCodeHostConnectionsService> | null
  readonly developmentDeliveryProvider: DevelopmentDeliveryProvider
  readonly repositoryPublicationTransport: ReturnType<typeof createRepositoryPublicationTransport>
}

type SqliteComposedAppDeps = RuntimeComposedAppDeps &
  RepositoryBootstrap & {
    readonly developmentAutomation: DevelopmentAutomationModule
    readonly developmentActivityOperations: DevelopmentActivityOperations
    readonly developmentActivityWorker: DevelopmentActivityWorkerBinding
    readonly developmentAdapterAclIdentity: ReturnType<
      typeof composeDevelopmentAdapterConfigOperations
    >['resourceAclIdentity']
    readonly developmentConfigOperations: DevelopmentConfigOperations
    readonly developmentMissionOperations: DevelopmentMissionOperations
  }

export type AppRouteMount = (app: Hono) => void

/**
 * Public transports are mounted before authentication.  Each binding is
 * composed by the selected provider and closes over provider-owned ports; the
 * common HTTP assembly never receives either database client.
 */
export interface AppPublicRouteMounts {
  readonly health: AppRouteMount
  readonly wellKnown: AppRouteMount
  readonly webhookIngress: AppRouteMount
}

/**
 * The route topology remains owned by this file.  Provider composition only
 * supplies closed mount bindings; `mountApiRoutes` invokes them below in one
 * fixed order for SQLite and PostgreSQL alike.
 */
export interface AppApiRouteMounts {
  readonly config: AppRouteMount
  readonly maintenance: AppRouteMount
  readonly daemon: AppRouteMount
  readonly plantuml: AppRouteMount
  readonly runtime: AppRouteMount
  readonly runtimes: AppRouteMount
  readonly overview: AppRouteMount
  readonly agents: AppRouteMount
  readonly mcps: AppRouteMount
  readonly plugins: AppRouteMount
  readonly skills: AppRouteMount
  readonly repos: AppRouteMount
  readonly cachedRepos: AppRouteMount
  readonly repoGroups: AppRouteMount
  readonly workflows: AppRouteMount
  readonly workgroups: AppRouteMount
  readonly resourcePackages: AppRouteMount
  readonly workgroupTasks: AppRouteMount
  readonly tasks: AppRouteMount
  readonly taskCatalog: AppRouteMount
  readonly taskArchive: AppRouteMount
  readonly maintenanceDisk: AppRouteMount
  readonly scheduledTasks: AppRouteMount
  readonly webhookEndpoints: AppRouteMount
  readonly codeHosts: AppRouteMount
  readonly repositoryTransportCredentials: AppRouteMount
  readonly code: AppRouteMount
  readonly capabilityTemplates: AppRouteMount
  readonly eventCenter: AppRouteMount
  readonly executionContracts: AppRouteMount
  readonly digitalEmployees: AppRouteMount
  readonly developmentConfig: AppRouteMount
  readonly developmentMissions: AppRouteMount
  readonly missionInputUploads: AppRouteMount
  readonly webhookTriggers: AppRouteMount
  readonly webhookDeliveries: AppRouteMount
  readonly backup: AppRouteMount
  readonly restore: AppRouteMount
  readonly databaseMigration?: AppRouteMount
  readonly worktreeFiles: AppRouteMount
  readonly portArtifacts: AppRouteMount
  readonly reviews: AppRouteMount
  readonly clarify: AppRouteMount
  readonly taskQuestions: AppRouteMount
  readonly taskClarifyDirective: AppRouteMount
  readonly fusion: AppRouteMount
  readonly intentSessions: AppRouteMount
  readonly memories: AppRouteMount
  readonly memoryDistillJobs: AppRouteMount
  readonly taskFeedback: AppRouteMount
  readonly auth: AppRouteMount
  readonly oidcAuth: AppRouteMount
  readonly oidc: AppRouteMount
  readonly users: AppRouteMount
  readonly docs: AppRouteMount
}

export type AppHttpProviderCore = Pick<
  DaemonProviderCore,
  'provider' | 'authRuntime' | 'tokenCallAudit' | 'identityAccess' | 'sourceWriteWindow'
>

/**
 * A production application keeps the complete selected-provider core.  HTTP
 * consumes only the authentication subset, while bootstrap reuses the same
 * value for WebSocket, health, repository and system-operation participants.
 */
export type SelectedDaemonProviderCore<
  TProvider extends DaemonProviderCore['provider'] = DaemonProviderCore['provider'],
> = Omit<
  DaemonProviderCore<
    TProvider extends 'postgresql' ? PostgresqlSystemOperationsModule : SystemOperationsModule
  >,
  'provider'
> & {
  readonly provider: TProvider
}

/**
 * Provider-neutral application assembly consumed by production daemon
 * sessions.  This contract intentionally contains no SQLite/PG handle and no
 * optional provider fallback.  A full `DaemonProviderCore` is structurally
 * sufficient for the closed fields below. Production compositions retain the
 * complete core as a subtype, so bootstrap also reuses its `realtime`
 * participant without rebuilding a WebSocket provider.
 */
export interface ComposedAppDeps<TCore extends AppHttpProviderCore = AppHttpProviderCore> {
  readonly token: string
  readonly configPath: string
  readonly core: TCore
  readonly publicRoutes: AppPublicRouteMounts
  readonly apiRoutes: AppApiRouteMounts
}

export type ProviderComposedAppDeps<
  TProvider extends DaemonProviderCore['provider'] = DaemonProviderCore['provider'],
> = ComposedAppDeps<SelectedDaemonProviderCore<TProvider>>

export interface ProviderPublicRouteComposition {
  readonly health: Readonly<{
    readonly deps: Parameters<typeof mountHealthRoutes>[1]
    readonly identityAccess: Parameters<typeof mountHealthRoutes>[2]
    readonly database: Parameters<typeof mountHealthRoutes>[3]
  }>
  readonly documentation: Parameters<typeof mountWellKnownRoutes>[1]
  readonly webhookIngress: Parameters<typeof mountWebhookIngressRoutes>[1]
}

export interface ProviderPlatformRouteComposition {
  readonly config: Parameters<typeof mountConfigRoutes>[1]
  readonly maintenance: Parameters<typeof mountMaintenanceRoutes>[1]
  readonly daemon: Parameters<typeof mountDaemonRoutes>[1]
  readonly plantuml: Parameters<typeof mountPlantumlRoutes>[1]
  readonly runtime: Parameters<typeof mountRuntimeRoutes>[1]
  readonly runtimes: Parameters<typeof mountRuntimesRoutes>[1]
  readonly overview: Readonly<{
    readonly authorization: Parameters<typeof mountOverviewRoutes>[1]
    readonly query: Parameters<typeof mountOverviewRoutes>[2]
  }>
}

export interface ProviderResourceCatalogRouteComposition {
  readonly agents: Parameters<typeof mountAgentRoutes>[1]
  readonly mcps: Parameters<typeof mountMcpRoutes>[1]
  readonly plugins: Parameters<typeof mountPluginRoutes>[1]
  readonly skills: Parameters<typeof mountSkillRoutes>[1]
  readonly repositories: Readonly<{
    readonly store: Parameters<typeof mountRepoRoutes>[1]
    readonly cached: Parameters<typeof mountCachedRepoRoutes>[1]
    readonly groups: Parameters<typeof mountRepoGroupRoutes>[1]
  }>
  readonly workflows: Readonly<{
    readonly runtime: Parameters<typeof mountWorkflowRoutes>[1]
    readonly module: Parameters<typeof mountWorkflowRoutes>[2]
  }>
  readonly workgroups: Parameters<typeof mountWorkgroupRoutes>[1]
  readonly resourcePackages: Parameters<typeof registerResourcePackageRoutes>[1] | null
  readonly workgroupTasks: Parameters<typeof mountWorkgroupTaskRoutes>[1]
}

export interface ProviderTaskExecutionRouteComposition {
  readonly tasks: Parameters<typeof mountTaskRoutes>[1]
  readonly catalog: Parameters<typeof mountTaskCatalogRoutes>[1]
  readonly archive: Parameters<typeof mountTaskArchiveRoutes>[1]
  readonly portArtifacts: Parameters<typeof mountPortArtifactRoutes>[1]
  readonly clarifyDirective: Parameters<typeof mountTaskClarifyDirectiveRoutes>[1]
  readonly feedback: Parameters<typeof mountTaskFeedbackRoutes>[1]
}

export interface ProviderIntegrationRouteComposition {
  readonly scheduledTasks: Parameters<typeof mountScheduledTaskRoutes>[1]
  readonly webhookEndpoints: Parameters<typeof mountWebhookEndpointRoutes>[1] | null
  readonly eventCenter: Parameters<typeof mountEventCenterRoutes>[1]
  readonly webhookTriggers: Readonly<{
    readonly deps: Parameters<typeof mountWebhookTriggerRoutes>[1]
    readonly identityAccess: Parameters<typeof mountWebhookTriggerRoutes>[2]
  }>
  readonly webhookDeliveries: Parameters<typeof mountWebhookDeliveryRoutes>[1]
}

export interface ProviderSourceControlRouteComposition {
  readonly codeHosts: Readonly<{
    readonly deps: Parameters<typeof mountCodeHostRoutes>[1]
    readonly service: Parameters<typeof mountCodeHostRoutes>[2]
  }>
  readonly repositoryTransportCredentials: Readonly<{
    readonly runtime: Parameters<typeof mountAccountRepositoryTransportCredentialRoutes>[1]
    readonly route: Parameters<typeof mountAccountRepositoryTransportCredentialRoutes>[2]
  }> | null
  readonly worktreeFiles: Parameters<typeof mountWorktreeFilesRoutes>[1]
}

export interface ProviderCodeRouteComposition {
  readonly history: Parameters<typeof mountCodeRoutes>[1]
  readonly capabilityTemplates: Parameters<typeof mountCapabilityTemplateRoutes>[1]
}

export interface ProviderDigitalDevelopmentRouteComposition {
  readonly executionContracts: Parameters<typeof mountExecutionContractRoutes>[1]
  readonly digitalEmployees: Readonly<{
    readonly persistence: Parameters<typeof mountDigitalEmployeeRoutes>[1]
    readonly module: Parameters<typeof mountDigitalEmployeeRoutes>[2]
    readonly activityOperations: Parameters<typeof mountDigitalEmployeeRoutes>[3]
    readonly contexts: Parameters<typeof mountDigitalEmployeeRoutes>[4]
  }>
  readonly developmentConfig: Readonly<{
    readonly aclRoutes: Parameters<typeof mountDevelopmentConfigRoutes>[1]
    readonly operations: Parameters<typeof mountDevelopmentConfigRoutes>[2]
    readonly contexts: Parameters<typeof mountDevelopmentConfigRoutes>[3]
  }>
  readonly developmentMissions: Readonly<{
    readonly operations: Parameters<typeof mountDevelopmentMissionRoutes>[1]
    readonly contexts: Parameters<typeof mountDevelopmentMissionRoutes>[2]
  }>
  readonly missionInputUploads: Parameters<typeof mountMissionInputUploadRoutes>[1]
}

export interface ProviderCollaborationRouteComposition {
  readonly operations: Parameters<typeof mountClarifyRoutes>[1]
  readonly appHome: Parameters<typeof mountReviewRoutes>[2]
}

export interface ProviderMemoryRouteComposition {
  readonly fusion: Parameters<typeof mountFusionRoutes>[1]
  readonly memories: Readonly<{
    readonly catalog: Parameters<typeof mountMemoryRoutes>[1]
    readonly identityAccess: Parameters<typeof mountMemoryRoutes>[2]
  }>
  readonly distillJobs: Parameters<typeof mountMemoryDistillJobRoutes>[1]
}

export interface ProviderIdentityRouteComposition {
  readonly auth: Readonly<{
    readonly deps: Parameters<typeof mountAuthRoutes>[1]
    readonly identityAccess: Parameters<typeof mountAuthRoutes>[2]
    readonly bindings: Parameters<typeof mountAuthRoutes>[3]
  }>
  readonly oidcAuth: Readonly<{
    readonly deps: Parameters<typeof mountOidcAuthRoutes>[1]
    readonly bindings: Parameters<typeof mountOidcAuthRoutes>[2]
  }>
  readonly oidc: Parameters<typeof mountOidcRoutes>[1]
  readonly users: Readonly<{
    readonly auth: Parameters<typeof mountUserRoutes>[1]
    readonly identityAccess: Parameters<typeof mountUserRoutes>[2]
  }>
}

export interface ProviderSystemRouteComposition {
  readonly maintenanceDisk: Parameters<typeof mountMaintenanceDiskRoutes>[1]
  readonly backup: Readonly<{
    readonly operations: Parameters<typeof mountBackupRoutes>[1]
    readonly identityAccess: Parameters<typeof mountBackupRoutes>[2]
  }>
  readonly restore: Readonly<{
    readonly operations: Parameters<typeof mountRestoreRoutes>[1]
    readonly identityAccess: Parameters<typeof mountRestoreRoutes>[2]
  }>
  readonly databaseMigration: Readonly<{
    readonly operations: Parameters<typeof mountDatabaseMigrationRoutes>[1]
    readonly identityAccess: Parameters<typeof mountDatabaseMigrationRoutes>[2]
  }>
}

/**
 * Complete provider-selected application input.  Every member is an owner
 * aggregate or closed route port; no route closure and no database handle may
 * cross this boundary.  `server.ts` alone turns these values into the fixed
 * route topology.
 */
export interface ProviderAppCompositionInput<
  TProvider extends DaemonProviderCore['provider'] = DaemonProviderCore['provider'],
> {
  readonly token: string
  readonly configPath: string
  readonly core: SelectedDaemonProviderCore<TProvider>
  readonly public: ProviderPublicRouteComposition
  readonly platform: ProviderPlatformRouteComposition
  readonly resourceCatalog: ProviderResourceCatalogRouteComposition
  readonly taskExecution: ProviderTaskExecutionRouteComposition
  readonly integration: ProviderIntegrationRouteComposition
  readonly sourceControl: ProviderSourceControlRouteComposition
  readonly code: ProviderCodeRouteComposition
  readonly digitalDevelopment: ProviderDigitalDevelopmentRouteComposition
  readonly collaboration: ProviderCollaborationRouteComposition
  readonly memory: ProviderMemoryRouteComposition
  readonly intent: IntentSessionRouteDependencies
  readonly identity: ProviderIdentityRouteComposition
  readonly system: ProviderSystemRouteComposition
}

export type SqliteAppCompositionInput = ProviderAppCompositionInput<'sqlite'>
export type PostgresqlAppCompositionInput = ProviderAppCompositionInput<'postgresql'>

/** Freeze one server-owned route assembly after its provider aggregates bind. */
function freezeComposedAppDeps<TCore extends AppHttpProviderCore>(
  input: ComposedAppDeps<TCore>,
): ComposedAppDeps<TCore> {
  return Object.freeze({
    token: input.token,
    configPath: input.configPath,
    core: Object.freeze({ ...input.core }),
    publicRoutes: Object.freeze({ ...input.publicRoutes }),
    apiRoutes: Object.freeze({ ...input.apiRoutes }),
  })
}

/**
 * Bind one daemon's already-composed owner aggregates to the canonical HTTP
 * route topology. Provider clients stay captured inside the injected
 * aggregates, so this boundary cannot silently select another provider.
 */
export function composeProviderAppDeps<TProvider extends DaemonProviderCore['provider']>(
  input: ProviderAppCompositionInput<TProvider>,
): ProviderComposedAppDeps<TProvider> {
  const publicRoutes = Object.freeze({
    health: (app: Hono) =>
      mountHealthRoutes(
        app,
        input.public.health.deps,
        input.public.health.identityAccess,
        input.public.health.database,
      ),
    wellKnown: (app: Hono) => mountWellKnownRoutes(app, input.public.documentation),
    webhookIngress: (app: Hono) => mountWebhookIngressRoutes(app, input.public.webhookIngress),
  } satisfies AppPublicRouteMounts)

  const apiRoutes = Object.freeze({
    config: (app: Hono) => mountConfigRoutes(app, input.platform.config),
    maintenance: (app: Hono) => mountMaintenanceRoutes(app, input.platform.maintenance),
    daemon: (app: Hono) => mountDaemonRoutes(app, input.platform.daemon),
    plantuml: (app: Hono) => mountPlantumlRoutes(app, input.platform.plantuml),
    runtime: (app: Hono) => mountRuntimeRoutes(app, input.platform.runtime),
    runtimes: (app: Hono) => mountRuntimesRoutes(app, input.platform.runtimes),
    overview: (app: Hono) =>
      mountOverviewRoutes(
        app,
        input.platform.overview.authorization,
        input.platform.overview.query,
      ),
    agents: (app: Hono) => mountAgentRoutes(app, input.resourceCatalog.agents),
    mcps: (app: Hono) => mountMcpRoutes(app, input.resourceCatalog.mcps),
    plugins: (app: Hono) => mountPluginRoutes(app, input.resourceCatalog.plugins),
    skills: (app: Hono) => mountSkillRoutes(app, input.resourceCatalog.skills),
    repos: (app: Hono) => mountRepoRoutes(app, input.resourceCatalog.repositories.store),
    cachedRepos: (app: Hono) =>
      mountCachedRepoRoutes(
        app,
        input.resourceCatalog.repositories.cached,
        input.resourceCatalog.repositories.store,
      ),
    repoGroups: (app: Hono) =>
      mountRepoGroupRoutes(
        app,
        input.resourceCatalog.repositories.groups,
        input.resourceCatalog.repositories.store,
      ),
    workflows: (app: Hono) =>
      mountWorkflowRoutes(
        app,
        input.resourceCatalog.workflows.runtime,
        input.resourceCatalog.workflows.module,
      ),
    workgroups: (app: Hono) => mountWorkgroupRoutes(app, input.resourceCatalog.workgroups),
    resourcePackages: (app: Hono) => {
      if (input.resourceCatalog.resourcePackages === null) return
      registerResourcePackageRoutes(app, input.resourceCatalog.resourcePackages)
    },
    workgroupTasks: (app: Hono) =>
      mountWorkgroupTaskRoutes(app, input.resourceCatalog.workgroupTasks),
    tasks: (app: Hono) => mountTaskRoutes(app, input.taskExecution.tasks),
    taskCatalog: (app: Hono) => mountTaskCatalogRoutes(app, input.taskExecution.catalog),
    taskArchive: (app: Hono) => mountTaskArchiveRoutes(app, input.taskExecution.archive),
    maintenanceDisk: (app: Hono) => mountMaintenanceDiskRoutes(app, input.system.maintenanceDisk),
    scheduledTasks: (app: Hono) => mountScheduledTaskRoutes(app, input.integration.scheduledTasks),
    webhookEndpoints: (app: Hono) => {
      if (input.integration.webhookEndpoints === null) return
      mountWebhookEndpointRoutes(app, input.integration.webhookEndpoints)
    },
    codeHosts: (app: Hono) =>
      mountCodeHostRoutes(
        app,
        input.sourceControl.codeHosts.deps,
        input.sourceControl.codeHosts.service,
      ),
    repositoryTransportCredentials: (app: Hono) => {
      const credentials = input.sourceControl.repositoryTransportCredentials
      if (credentials === null) return
      mountAccountRepositoryTransportCredentialRoutes(app, credentials.runtime, credentials.route)
    },
    code: (app: Hono) => mountCodeRoutes(app, input.code.history),
    capabilityTemplates: (app: Hono) =>
      mountCapabilityTemplateRoutes(app, input.code.capabilityTemplates),
    eventCenter: (app: Hono) => mountEventCenterRoutes(app, input.integration.eventCenter),
    executionContracts: (app: Hono) =>
      mountExecutionContractRoutes(app, input.digitalDevelopment.executionContracts),
    digitalEmployees: (app: Hono) =>
      mountDigitalEmployeeRoutes(
        app,
        input.digitalDevelopment.digitalEmployees.persistence,
        input.digitalDevelopment.digitalEmployees.module,
        input.digitalDevelopment.digitalEmployees.activityOperations,
        input.digitalDevelopment.digitalEmployees.contexts,
      ),
    developmentConfig: (app: Hono) =>
      mountDevelopmentConfigRoutes(
        app,
        input.digitalDevelopment.developmentConfig.aclRoutes,
        input.digitalDevelopment.developmentConfig.operations,
        input.digitalDevelopment.developmentConfig.contexts,
      ),
    developmentMissions: (app: Hono) =>
      mountDevelopmentMissionRoutes(
        app,
        input.digitalDevelopment.developmentMissions.operations,
        input.digitalDevelopment.developmentMissions.contexts,
      ),
    missionInputUploads: (app: Hono) =>
      mountMissionInputUploadRoutes(app, input.digitalDevelopment.missionInputUploads),
    webhookTriggers: (app: Hono) =>
      mountWebhookTriggerRoutes(
        app,
        input.integration.webhookTriggers.deps,
        input.integration.webhookTriggers.identityAccess,
      ),
    webhookDeliveries: (app: Hono) =>
      mountWebhookDeliveryRoutes(app, input.integration.webhookDeliveries),
    backup: (app: Hono) =>
      mountBackupRoutes(app, input.system.backup.operations, input.system.backup.identityAccess),
    restore: (app: Hono) =>
      mountRestoreRoutes(app, input.system.restore.operations, input.system.restore.identityAccess),
    databaseMigration: (app: Hono) =>
      mountDatabaseMigrationRoutes(
        app,
        input.system.databaseMigration.operations,
        input.system.databaseMigration.identityAccess,
      ),
    worktreeFiles: (app: Hono) => mountWorktreeFilesRoutes(app, input.sourceControl.worktreeFiles),
    portArtifacts: (app: Hono) => mountPortArtifactRoutes(app, input.taskExecution.portArtifacts),
    reviews: (app: Hono) =>
      mountReviewRoutes(app, input.collaboration.operations, input.collaboration.appHome),
    clarify: (app: Hono) => mountClarifyRoutes(app, input.collaboration.operations),
    taskQuestions: (app: Hono) => mountTaskQuestionRoutes(app, input.collaboration.operations),
    taskClarifyDirective: (app: Hono) =>
      mountTaskClarifyDirectiveRoutes(app, input.taskExecution.clarifyDirective),
    fusion: (app: Hono) => mountFusionRoutes(app, input.memory.fusion),
    intentSessions: (app: Hono) => mountIntentSessionRoutes(app, input.intent),
    memories: (app: Hono) =>
      mountMemoryRoutes(app, input.memory.memories.catalog, input.memory.memories.identityAccess),
    memoryDistillJobs: (app: Hono) => mountMemoryDistillJobRoutes(app, input.memory.distillJobs),
    taskFeedback: (app: Hono) => mountTaskFeedbackRoutes(app, input.taskExecution.feedback),
    auth: (app: Hono) =>
      mountAuthRoutes(
        app,
        input.identity.auth.deps,
        input.identity.auth.identityAccess,
        input.identity.auth.bindings,
      ),
    oidcAuth: (app: Hono) =>
      mountOidcAuthRoutes(app, input.identity.oidcAuth.deps, input.identity.oidcAuth.bindings),
    oidc: (app: Hono) => mountOidcRoutes(app, input.identity.oidc),
    users: (app: Hono) =>
      mountUserRoutes(app, input.identity.users.auth, input.identity.users.identityAccess),
    docs: (app: Hono) => mountDocsRoutes(app, input.public.documentation),
  } satisfies AppApiRouteMounts)

  return freezeComposedAppDeps({
    token: input.token,
    configPath: input.configPath,
    core: input.core,
    publicRoutes,
    apiRoutes,
  })
}

/** Named production entry points keep provider selection explicit at bootstrap. */
export function composeSqliteProviderAppDeps(
  input: SqliteAppCompositionInput,
): ProviderComposedAppDeps<'sqlite'> {
  return composeProviderAppDeps(input)
}

export function composePostgresqlAppDeps(
  input: PostgresqlAppCompositionInput,
): ProviderComposedAppDeps<'postgresql'> {
  return composeProviderAppDeps(input)
}

function composeLegacyConfigConcurrencyHotApply(
  daemonScope: object,
): ConfigConcurrencyHotApplyCommand {
  return Object.freeze({
    apply(input: Parameters<ConfigConcurrencyHotApplyCommand['apply']>[0]) {
      resizeAllNodePools(daemonScope, {
        agent: input.maxConcurrentNodes,
        script: input.maxConcurrentScriptNodes,
        'code-host': input.maxConcurrentCodeHostCalls,
      })
      resizeAllTaskFanoutSems(input.multiProcessSubprocessConcurrency)
      setChildTaskBudgetCapacity(input.maxActiveChildTasks)
    },
  })
}

function composeSqliteDevelopmentConfigResourceAccess(
  db: DbClient,
): DevelopmentConfigResourceAccess {
  return Object.freeze({
    filterVisible<T extends DevelopmentConfigAccessRow>(
      actor: DirectAuthenticatedAuthority,
      type: AclResourceType,
      rows: readonly T[],
    ): Promise<T[]> {
      return filterVisibleRows(db, actor, type, rows)
    },
    canView(
      actor: DirectAuthenticatedAuthority,
      type: AclResourceType,
      row: DevelopmentConfigAccessRow,
    ): Promise<boolean> {
      return canViewResource(db, actor, type, row)
    },
    requireEdit(
      actor: DirectAuthenticatedAuthority,
      type: AclResourceType,
      row: DevelopmentConfigAccessRow,
    ): Promise<ResourceAccess> {
      return requireResourceEdit(db, actor, type, row)
    },
    requireGovern(
      actor: DirectAuthenticatedAuthority,
      type: AclResourceType,
      row: DevelopmentConfigAccessRow,
    ): Promise<void> {
      return requireResourceGovern(db, actor, type, row)
    },
    assertNameUnchangedForEditor,
  })
}

function composeSqliteDevelopmentConfigAclRoutes(
  db: DbClient,
  developmentAdapterAclIdentity: SqliteComposedAppDeps['developmentAdapterAclIdentity'],
): DevelopmentConfigAclRouteBinding {
  return Object.freeze({
    mount(input: Parameters<DevelopmentConfigAclRouteBinding['mount']>[0]) {
      mountAclEndpoints(input.app, {
        type: input.type,
        base: input.base,
        param: 'id',
        load: input.load,
        canView: (actor, row) => canViewResource(db, actor, input.type, row),
        read: (actor, row) =>
          getResourceAcl(
            db,
            actor,
            input.type,
            row,
            input.type === developmentAdapterAclIdentity.type
              ? developmentAdapterAclIdentity
              : undefined,
          ),
        update: (actor, row, body, updatedAt) =>
          updateResourceAcl(db, actor, input.type, row, body, {
            ...(input.type === developmentAdapterAclIdentity.type
              ? { identityPersistence: developmentAdapterAclIdentity }
              : {}),
            ...(updatedAt === undefined ? {} : { updatedAt }),
          }),
        notFoundCode: input.notFoundCode,
      })
    },
  })
}

function composeApplicationEventCenter(
  deps: SqliteAppDeps,
  developmentDeliveryProvider: DevelopmentDeliveryProvider,
): EventCenterModule {
  const approvalGateway = composeSqliteApprovalGatewayRunner(deps.db)
  const missionContinuation = createSqliteMissionCodeHostEventContinuation(deps.db)
  const codeHostDeliveryDispatcher =
    deps.webhookDispatcher !== undefined &&
    supportsEventCenterCodeHostDelivery(deps.webhookDispatcher)
      ? deps.webhookDispatcher
      : null
  const eventWorkStarter =
    deps.webhookDispatcher !== undefined && supportsEventCenterWorkStart(deps.webhookDispatcher)
      ? deps.webhookDispatcher
      : null
  return deferEventCenterModule(
    composeEventCenter({
      db: deps.db,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        codeHostEventCatalogJson,
        taskLifecycleEventCatalogJson,
        digitalEmployeeLifecycleEventCatalogJson,
      ],
      observer: composeDevelopmentEmployeeEventObserver({
        codeHost: composeDevelopmentCodeHostEventObserver({
          binding: (repositoryId) =>
            resolveDevelopmentRepoBinding(developmentDeliveryProvider, repositoryId),
        }),
        approval: composeDevelopmentApprovalEventObserver({ gateway: approvalGateway }),
      }),
      routingSubscriptions: createCodeHostWebhookRoutingDirectory(deps.db, missionContinuation),
      ...(eventWorkStarter === null
        ? {}
        : {
            automationWorkStart: {
              launch: (input) => eventWorkStarter.dispatchEventTarget(input),
            },
          }),
      deliveryConsumers:
        codeHostDeliveryDispatcher === null
          ? []
          : [
              createCodeHostWebhookDeliveryConsumer(
                deps.db,
                codeHostDeliveryDispatcher,
                missionContinuation,
              ),
            ],
      deliveryRetryLimits: {
        current() {
          const config = loadConfig(deps.configPath)
          return {
            defaultNodeRetries: config.defaultNodeRetries,
            sessionRestartBudget: config.sessionRestartBudget,
          }
        },
      },
    }),
  )
}

/**
 * SQLite compatibility provider for tests/installs without a secret box. It
 * keeps repository reads and pipeline evidence real, while the credentialed
 * code-host binding correctly reports unavailable because no connection can
 * be decrypted. Production daemon composition supplies the credentialed
 * provider instead.
 */
function composeSqliteUncredentialedDevelopmentDeliveryProvider(input: {
  readonly db: DbClient
  readonly store: RepositoryWorkspaceStore
  readonly secretBox?: SecretBox
}): DevelopmentDeliveryProvider {
  return Object.freeze({
    async resolveRepository(
      repositoryId: Parameters<DevelopmentDeliveryProvider['resolveRepository']>[0],
    ) {
      const row = await input.store.findCachedRepoById(repositoryId)
      if (row === null) return null
      const remoteUrl = unsealRepoUrl(row, input.secretBox, input.store)
      return remoteUrl === null ? null : { remoteUrl, defaultBranch: row.defaultBranch ?? null }
    },
    async resolveBinding(
      _repositoryId: Parameters<DevelopmentDeliveryProvider['resolveBinding']>[0],
    ) {
      return null
    },
    async readMrFactTarget(
      request: Parameters<DevelopmentDeliveryProvider['readMrFactTarget']>[0],
    ) {
      return (
        input.db
          .select({
            repositoryId: developmentMissions.repositoryId,
            mrIid: developmentMrClaims.mrIid,
          })
          .from(developmentMissions)
          .innerJoin(
            developmentMrClaims,
            and(
              eq(developmentMrClaims.id, request.mrClaimId),
              eq(developmentMrClaims.missionId, developmentMissions.id),
            ),
          )
          .where(eq(developmentMissions.id, request.missionId))
          .get() ?? null
      )
    },
    pipeline: composeSqlitePipelineEvidenceRunner(input.db),
  })
}

function composeRepositoryBootstrap(deps: SqliteAppDeps, appHome: string): RepositoryBootstrap {
  const repositoryWorkspaceStore =
    deps.repositoryWorkspaceStore ??
    deps.providerCore?.repositoryWorkspaceStore ??
    composeSqliteRepositoryWorkspaceStore(deps.db)
  const repositoryWorkspaceOperations =
    deps.providerCore?.repositoryWorkspaceOperations ??
    composeRepositoryWorkspaceOperations(repositoryWorkspaceStore, deps.secretBox)
  const repository =
    deps.repositoryTransportCredentialRepository ??
    deps.providerCore?.repositoryTransportCredentialRepository ??
    new SQLiteRepositoryTransportCredentialRepository(deps.db)
  const repositoryTransport =
    deps.repositoryTransport ??
    (deps.secretBox === undefined
      ? null
      : composeRepositoryTransportCredentials(repository, deps.secretBox))
  if (repositoryTransport !== null) {
    void reconcileRepositoryTransportConnectionProjections(
      repository,
      repositoryTransport.adminConnections,
    )
  }
  const codeHostConnections =
    deps.secretBox === undefined || repositoryTransport === null
      ? null
      : createCodeHostConnectionsService({
          secretBox: deps.secretBox,
          repositoryTransport: repositoryTransport.adminConnections,
        })
  const developmentDeliveryProvider =
    codeHostConnections === null
      ? composeSqliteUncredentialedDevelopmentDeliveryProvider({
          db: deps.db,
          store: repositoryWorkspaceStore,
          ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
        })
      : createSqliteDevelopmentDeliveryProvider({
          db: deps.db,
          ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
          connections: codeHostConnections,
          pipeline: composeSqlitePipelineEvidenceRunner(deps.db),
        })
  const repositoryEndpointDiscovery =
    codeHostConnections === null
      ? undefined
      : createRepositoryEndpointDiscovery({
          async resolveConnection(provider) {
            const connection = await codeHostConnections.resolve(provider)
            if (connection?.connectionGeneration === undefined) return null
            return {
              provider: connection.provider,
              apiBaseUrl: connection.baseUrl,
              connectionGeneration: connection.connectionGeneration,
              token: connection.token,
              rejectUnauthorized: connection.rejectUnauthorized,
            }
          },
          ...(deps.codeHostFetch === undefined ? {} : { fetchImpl: deps.codeHostFetch }),
        })
  return Object.freeze({
    repositoryWorkspaceStore,
    repositoryWorkspaceOperations,
    repositoryTransport,
    codeHostConnections,
    developmentDeliveryProvider,
    repositoryPublicationTransport:
      deps.repositoryPublicationTransport ??
      createRepositoryPublicationTransport({
        repository,
        ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
        appHome,
        ...(repositoryEndpointDiscovery === undefined
          ? {}
          : { endpointDiscovery: repositoryEndpointDiscovery }),
      }),
  })
}

function composeFallbackDevelopmentAutomation(
  deps: RuntimeComposedAppDeps & RepositoryBootstrap,
  appHome: string,
): DevelopmentAutomationModule {
  const automationRef: { current: DevelopmentAutomationModule | null } = { current: null }
  const terminalObserver = createSqliteDevelopmentMissionExecutionTerminalObserver({
    db: deps.db,
    drive: (missionId) => {
      const automation = automationRef.current
      if (automation === null) {
        return Promise.reject(new Error('development-automation-not-composed'))
      }
      return automation.drive(missionId)
    },
  })
  const automation = composeDevelopmentAutomation({
    db: deps.db,
    appHome,
    admissionLookup: deps.developmentAdmissionLookup,
    requirementSource: composeSqliteRequirementSourceRunner(deps.db),
    changeCandidate: bindChangeCandidateParticipant(),
    candidateDelivery: bindCandidateDeliveryParticipant({
      publicationTransport: deps.repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
    ...buildDevelopmentDeliveryDeps(deps.developmentDeliveryProvider),
    ...buildDevelopmentPipelineDeps(deps.developmentDeliveryProvider.pipeline),
    ...buildDevelopmentMrFactsDeps(deps.developmentDeliveryProvider),
    agentLauncher: composeAgentActionExecution({
      db: deps.db,
      startDeps: buildStartTaskDeps(
        deps.db,
        deps.schedulerDriver,
        deps.configPath,
        SYSTEM_USER_ID,
        deps.secretBox,
        deps.identityAccess,
      ),
      onTerminal: terminalObserver.agent,
    }),
    scriptLauncher: composeScriptActionExecution({
      db: deps.db,
      startDeps: buildStartTaskDeps(
        deps.db,
        deps.schedulerDriver,
        deps.configPath,
        SYSTEM_USER_ID,
        deps.secretBox,
        deps.identityAccess,
      ),
      onTerminal: terminalObserver.script,
    }),
    approvalGateway: composeSqliteApprovalGatewayRunner(deps.db),
  })
  automationRef.current = automation
  return automation
}

export function composeSqliteAppDeps(
  deps: AppDeps & { readonly providerCore: SelectedDaemonProviderCore<'sqlite'> },
): ProviderComposedAppDeps<'sqlite'>
export function composeSqliteAppDeps(deps: AppDeps): ComposedAppDeps
export function composeSqliteAppDeps(deps: AppDeps): ComposedAppDeps {
  const appHome = deps.appHome ?? Paths.root
  const repositoryBootstrap = composeRepositoryBootstrap(deps, appHome)
  const identityAccess = withIntegrationTriggerResources(
    deps.db,
    deps.identityAccess ??
      deps.providerCore?.identityAccess ??
      createIdentityAccessRuntime({ db: deps.db }),
  )
  const authRuntime =
    deps.authRuntime ?? deps.providerCore?.authRuntime ?? createSqliteAuthRuntime({ db: deps.db })
  const tokenCallAudit =
    deps.tokenCallAudit ?? deps.providerCore?.tokenCallAudit ?? createSqliteTokenCallAudit(deps.db)
  const healthDatabase =
    deps.healthDatabase ??
    deps.providerCore?.healthDatabase ??
    createSqliteHealthDatabaseReadModel(deps.db)
  const webhookIngressPersistence =
    deps.webhookIngressPersistence ?? composeSqliteWebhookIngressPersistence(deps.db)
  const runtimeRegistry =
    deps.runtimeRegistry ??
    deps.providerCore?.runtimeRegistry ??
    composeSqliteRuntimeRegistryOperations(deps.db)
  const configConcurrencyHotApply =
    deps.configConcurrencyHotApply ?? composeLegacyConfigConcurrencyHotApply(deps.db)
  const memoryInjectionQueries =
    deps.memoryOperations?.injectionQueries ?? composeSqliteMemoryInjectionQueries(deps.db)
  const taskExecutionPersistence = createSqliteTaskExecutionPersistence(deps.db)
  const taskExecutionRuntime =
    deps.schedulerDriver !== undefined && deps.taskExecutionReadModels !== undefined
      ? undefined
      : composeTaskExecutionRuntime({
          participants: createSqliteTaskExecutionRuntimeParticipants({
            db: deps.db,
            memoryInjectionQueries,
            collaborationRuntime: createSqliteCollaborationRuntimeMechanics(deps.db),
            persistence: taskExecutionPersistence,
            runtimeSessionLeases: createSqliteRuntimeSessionLeaseOperations(deps.db),
            runtimeRegistry,
            dynamicWorkflow: {
              persistence: composeSqliteDynamicWorkflowPersistence(deps.db),
              validationContext: composeSqliteDynamicWorkflowValidationContext(deps.db),
            },
            identityAccess,
            repositoryPublicationTransport: repositoryBootstrap.repositoryPublicationTransport,
          }),
          readModels: deps.taskExecutionReadModels ?? taskExecutionPersistence.reads,
        })
  const schedulerDriver = requireSchedulerDriver(
    deps.schedulerDriver ?? taskExecutionRuntime?.schedulerDriver,
  )
  const taskExecutionReadModels = deps.taskExecutionReadModels ?? taskExecutionRuntime?.readModels
  if (taskExecutionReadModels === undefined) {
    throw new Error('task-execution-read-models-not-composed')
  }
  const systemOperations =
    deps.systemOperations ??
    deps.providerCore?.systemOperations ??
    composeSystemOperations({
      db: deps.db,
      secretBox: deps.secretBox,
      appHome,
      repositoryBackupPreparation:
        repositoryBootstrap.repositoryWorkspaceOperations.backupPreparation,
    })
  const maintenanceDisk =
    deps.providerCore?.maintenanceDisk ?? composeSqliteMaintenanceDiskOperations(deps.db, appHome)
  let collaborationContext = deps.collaborationContext
  const memoryOperations =
    deps.memoryOperations ??
    composeSqliteMemoryOperations({
      db: deps.db,
      injectionQueries: memoryInjectionQueries,
      reviewedArtifacts: {
        read: async (finalPath) => {
          if (collaborationContext === undefined) {
            throw new Error('collaboration-command-context-not-composed')
          }
          return await readCommittedReviewArtifactBody(collaborationContext, finalPath)
        },
      },
    })
  collaborationContext ??= createCollaborationCommandContext({
    db: deps.db,
    appHome,
    taskExecutionReadModels,
    reviewDecisions: createSqliteReviewDecisionCommand({ db: deps.db, appHome }),
    questionDispatches: createSqliteQuestionDispatchCommand(deps.db),
    clarifyDecisions: createSqliteClarifyDecisionCommand(deps.db, memoryOperations.distillCommands),
  })
  const runtimeDeps: RuntimeComposedAppDeps = {
    ...(deps.digitalEmployeeEventCenter === undefined
      ? {
          ...deps,
          digitalEmployeeEventCenter: composeApplicationEventCenter(
            deps,
            repositoryBootstrap.developmentDeliveryProvider,
          ),
        }
      : deps),
    appHome,
    authRuntime,
    tokenCallAudit,
    healthDatabase,
    systemOperations,
    maintenanceDisk,
    webhookIngressPersistence,
    runtimeRegistry,
    configConcurrencyHotApply,
    identityAccess,
    digitalEmployeeCaseDetailProjection:
      deps.digitalEmployeeCaseDetailProjection ??
      composeDevelopmentEmployeeCaseDetailProjection(
        createSqliteDevelopmentEmployeeCaseWorkspaceDetailReader(deps.db),
      ),
    schedulerDriver,
    taskExecutionReadModels,
    executionContracts:
      deps.executionContracts ??
      composeExecutionContract({
        db: deps.db,
        appHome,
        registrations: developmentExecutionContractRegistrations,
        implicitAgentDeclarations: developmentImplicitAgentContractDeclarations,
      }),
    codeHistoryQueries: deps.codeHistoryQueries ?? composeSqliteCodeHistoryQueries(deps.db),
    developmentAdmissionLookup:
      deps.developmentAdmissionLookup ?? composeSqliteDevelopmentAdmissionLookup(deps.db),
    memoryDistillCommands: memoryOperations.distillCommands,
    memoryDistillQueries: deps.memoryDistillQueries ?? memoryOperations.distillQueries,
    memoryOperations,
    collaborationContext,
  }
  const developmentAdapterConfigOperations = composeDevelopmentAdapterConfigOperations(
    runtimeDeps.db,
  )
  const developmentConfigOperations = composeDevelopmentConfigOperations(
    runtimeDeps.db,
    developmentAdapterConfigOperations,
    composeSqliteDevelopmentConfigResourceAccess(runtimeDeps.db),
  )
  const developmentActivityWorker = createDevelopmentActivityWorkerBinding()
  const developmentAutomation =
    runtimeDeps.developmentAutomation ??
    composeFallbackDevelopmentAutomation({ ...runtimeDeps, ...repositoryBootstrap }, appHome)
  const developmentMissionOperations = composeDevelopmentMissionOperations({
    db: runtimeDeps.db,
    deliveryProvider: repositoryBootstrap.developmentDeliveryProvider,
    admissionLookup: runtimeDeps.developmentAdmissionLookup,
    automation: developmentAutomation,
    legacyAdmissionsEnabled: createLegacyMissionAdmissionsEnabledQuery(
      composeSqliteDigitalEmployeeWriterCutover(runtimeDeps.db),
    ),
  })
  const effectiveDeps: SqliteComposedAppDeps = {
    ...runtimeDeps,
    ...repositoryBootstrap,
    // RFC-317 T54：装配落在 bootstrap。HTTP 与 MCP operation adapter
    // 拿到的是**同一个**实例；MCP 不再另建 route table。
    developmentAutomation,
    developmentActivityOperations: developmentActivityWorker.operations,
    developmentActivityWorker,
    developmentAdapterAclIdentity: developmentAdapterConfigOperations.resourceAclIdentity,
    developmentConfigOperations,
    developmentMissionOperations,
  }

  let mcpCatalogRef: McpCatalogModule | null = null
  const userRuntimeTests =
    effectiveDeps.mcpRuntimeTests ??
    getMcpRuntimeTestService({
      ...composeSqliteMcpRuntimeTestProvider(effectiveDeps.db),
      async loadMcp(mcpId) {
        if (mcpCatalogRef === null) throw new Error('mcp-catalog-not-composed')
        const identity = await admitDaemonIdentity(identityAccess)
        if (identity === null) throw new Error('mcp-runtime-test-authority-not-admitted')
        return mcpCatalogRef.queries.get(identity.actor, { id: mcpId })
      },
      loadRuntime: (name) => effectiveDeps.runtimeRegistry.getRuntime(name),
      configPath: effectiveDeps.configPath,
      appHome: effectiveDeps.mcpRuntimeTestDependencies?.appHome ?? Paths.root,
      ...(effectiveDeps.mcpRuntimeTestDependencies?.runFn === undefined
        ? {}
        : { runFn: effectiveDeps.mcpRuntimeTestDependencies.runFn }),
      ...(effectiveDeps.mcpRuntimeTestDependencies?.now === undefined
        ? {}
        : { now: effectiveDeps.mcpRuntimeTestDependencies.now }),
      ...(effectiveDeps.mcpRuntimeTestDependencies?.capacity === undefined
        ? {}
        : { capacity: effectiveDeps.mcpRuntimeTestDependencies.capacity }),
    })
  const providerResourceCatalog = composeSqliteResourceCatalog({ db: effectiveDeps.db })
  const agentResourceIntegrity = composeSqliteAgentResourceIntegrity({
    db: effectiveDeps.db,
    authorization: providerResourceCatalog.authorization,
  })
  const agentResourceIntegrityQueries = agentResourceIntegrity.queries
  const agentCatalog = composeAgentCatalog({
    db: effectiveDeps.db,
    importQueries: composeSqliteAgentImportQueries(effectiveDeps.db),
    resourceIntegrityQueries: agentResourceIntegrityQueries,
  })
  const mcpProbeStore = composeSqliteMcpProbeStore(effectiveDeps.db)
  const mcpCatalog = composeMcpCatalog({
    db: effectiveDeps.db,
    coordinator: mcpOperationCoordinator,
    nextMutationTimestamp: async (mcp) => {
      const persisted = await getProbeByMcpId(mcpProbeStore, mcp.id)
      return mcpOperationCoordinator.nextCausalTimestamp(mcp.id, mcpRouteNow(), [
        mcp.updatedAt + 1,
        (persisted?.startedAt ?? 0) + 1,
        mcpOperationCoordinator.activeLastStartedAt(mcp.id) + 1,
      ])
    },
    runtime: Object.freeze({
      prepareDelete: (mcpId: string) => userRuntimeTests.prepareMcpDelete(mcpId),
      reconcileDurableIntents: () => userRuntimeTests.reconcileDurableIntents(),
    }),
    transitionMutationInTx: transitionMcpRuntimeTestsInTx,
    deletePreparedInTx: deletePreparedMcpRuntimeTestsInTx,
  })
  mcpCatalogRef = mcpCatalog
  const pluginCatalog = composePluginCatalog({
    db: effectiveDeps.db,
    coordinator: pluginOperationCoordinator,
  })
  const skillCatalog = composeSkillCatalog({ db: effectiveDeps.db, appHome: Paths.root })
  const workflowCatalog = composeWorkflowCatalog({ db: effectiveDeps.db })
  const workgroupCatalog = composeWorkgroupCatalog({ db: effectiveDeps.db })
  const resourcePackageCatalog =
    effectiveDeps.secretBox === undefined
      ? null
      : (() => {
          const provider = composeSqliteResourcePackageProvider({
            db: effectiveDeps.db,
            appHome,
          })
          return composeResourcePackageOperations({
            execution: createSqliteResourcePackageExecutionAdapter({
              db: effectiveDeps.db,
              appHome,
              box: effectiveDeps.secretBox,
              provider,
            }),
            resources: provider.resources,
          })
        })()
  const resourceScopeAuthorization = composeResourceScopeAuthorizationBinding()
  const overviewQuery: OverviewRouteQuery = Object.freeze({
    execute: (input: Parameters<OverviewRouteQuery['execute']>[0]) =>
      buildOverview(
        effectiveDeps.db,
        {
          actor: input.actor,
          authority: input.authority,
          authorization: resourceScopeAuthorization,
        },
        repositoryBootstrap.repositoryWorkspaceOperations.overviewQueries,
      ),
  })
  const intentApply = composeSqliteIntentApplyOperations({
    db: effectiveDeps.db,
    appHome,
    resources: composeIntentApplyResourceBinding(
      legacyIntentApplyResourceDependencies,
      providerResourceCatalog.persistence.identities,
    ),
    artifacts: createSqliteIntentApplyArtifactLifecycle({
      db: effectiveDeps.db,
      appHome,
    }),
  })
  const identityUserOperations = composeIdentityUserOperations({
    identityAccess,
    auth: effectiveDeps.authRuntime,
    afterDisabled: async () => userRuntimeTests.reconcileDurableIntents(),
  })
  const apiRoutes = composeSqliteApiRouteMounts(
    effectiveDeps,
    identityAccess,
    identityUserOperations,
    systemOperations,
    userRuntimeTests,
    agentCatalog,
    mcpCatalog,
    mcpProbeStore,
    pluginCatalog,
    skillCatalog,
    workflowCatalog,
    workgroupCatalog,
    resourcePackageCatalog,
    providerResourceCatalog,
    resourceScopeAuthorization,
    agentResourceIntegrity,
    overviewQuery,
    intentApply,
    taskExecutionPersistence,
  )
  return freezeComposedAppDeps({
    token: effectiveDeps.token,
    configPath: effectiveDeps.configPath,
    core:
      effectiveDeps.providerCore === undefined
        ? Object.freeze({
            provider: 'sqlite',
            authRuntime,
            tokenCallAudit,
            identityAccess,
            // Compatibility `createApp` has no migration admission to consult.
            sourceWriteWindow: ALWAYS_WRITABLE_DATABASE_SOURCE,
          })
        : Object.freeze({ ...effectiveDeps.providerCore, identityAccess }),
    publicRoutes: Object.freeze({
      health: (app: Hono) =>
        mountHealthRoutes(app, effectiveDeps, identityAccess.diagnostics, healthDatabase),
      wellKnown: (app: Hono) => mountWellKnownRoutes(app, effectiveDeps),
      webhookIngress: (app: Hono) => mountWebhookIngressRoutes(app, effectiveDeps),
    }),
    apiRoutes,
  })
}

export function composeDigitalEmployeeRoutePersistence(input: {
  readonly identityAccess: IdentityAccessRuntime
  readonly resourceCatalog: ProviderResourceCatalogComposition
  readonly acl: {
    getResourceAcl(
      actor: Actor,
      type: DigitalEmployeeAclResourceType,
      row: {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'private' | 'public'
      },
    ): Promise<ResourceAcl>
    updateResourceAcl(
      actor: Actor,
      type: DigitalEmployeeAclResourceType,
      row: {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'private' | 'public'
      },
      body: UpdateResourceAclBody,
      options?: Parameters<typeof updateResourceAcl>[5],
    ): Promise<ResourceAcl>
  }
}): DigitalEmployeeRoutePersistence {
  async function assertActiveMembers(subject: {
    readonly ownerUserId?: string
    readonly members?: readonly { readonly userId: string }[]
  }): Promise<void> {
    const referenced = new Set((subject.members ?? []).map((member) => member.userId))
    if (subject.ownerUserId !== undefined) referenced.add(subject.ownerUserId)
    if (referenced.size === 0) return
    const people = await input.identityAccess.userDirectory.lookup([...referenced])
    const active = new Set(
      people.filter((person) => person.status === 'active').map((person) => person.id),
    )
    const invalid = [...referenced].filter(
      (userId) => userId === SYSTEM_USER_ID || !active.has(userId),
    )
    if (invalid.length === 0) return
    throw new ValidationError('members-user-invalid', 'referenced user(s) not active', {
      userIds: invalid,
    })
  }

  async function getCaseMembers(
    actor: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[0],
    runtime: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[1],
    row: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[2],
  ): ReturnType<DigitalEmployeeRoutePersistence['getCaseMembers']> {
    const memberRows = await runtime.queries.listCaseMembers(row.id)
    const wanted = [
      ...new Set([
        ...(row.ownerUserId === null ? [] : [row.ownerUserId]),
        ...memberRows.map((member) => member.userId),
      ]),
    ]
    const people =
      wanted.length === 0 ? [] : await input.identityAccess.userDirectory.lookup(wanted)
    const byId = new Map(people.map((person) => [person.id, person]))
    const owner =
      row.ownerUserId === null || row.ownerUserId === SYSTEM_USER_ID
        ? null
        : (byId.get(row.ownerUserId) ?? null)
    const members = memberRows.flatMap((member) => {
      const user = byId.get(member.userId)
      return user === undefined ? [] : [{ user, role: member.role }]
    })
    const canManage = canManageCaseMembers(actor, row)
    return {
      caseId: row.id,
      ownerUserId: row.ownerUserId,
      owner,
      members,
      canManage,
      canOperate:
        canManage ||
        memberRows.some(
          (member) => member.role === 'collaborator' && member.userId === actor.user.id,
        ),
    }
  }

  return Object.freeze({
    assertNameUnchangedForEditor,
    adapterVisibilitySubject(actor: Actor) {
      return { userId: actor.user.id, authority: resourceAclAudienceAuthority(actor) }
    },
    projectVisibleRowsWithAccess: (actor, type, rows) =>
      input.resourceCatalog.authorization.projectVisibleRowsWithAccess(actor, type, rows),
    filterVisibleRows: (actor, type, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(actor, type, rows),
    requireResourceEdit: (actor, type, row) =>
      input.resourceCatalog.authorization.requireResourceEdit(actor, type, row),
    requireResourceGovern: (actor, type, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(actor, type, row),
    getCaseMembers,
    async updateCaseMembers(actor, runtime, row, body) {
      if (!canManageCaseMembers(actor, row)) {
        throw new ForbiddenError(
          'forbidden',
          'only the employee case owner or an actor with resource-acl:bypass can manage members',
        )
      }
      await assertActiveMembers(body)
      const current = await runtime.queries.listCaseMembers(row.id)
      const plan = planMembersReplacement({
        prevOwner: row.ownerUserId,
        requestedOwner: body.ownerUserId,
        requestedMembers: body.members,
        currentMembers: current,
      })
      const committed = await runtime.commands.replaceCaseMembers({
        caseId: row.id,
        ownerUserId: plan.nextOwner,
        members: [...plan.nextMembers].map(([userId, role]) => ({ userId, role })),
        addedBy: actor.user.id,
        now: Date.now(),
      })
      const visibleUserIds = new Set<string>()
      if (committed.previousOwnerUserId !== null) {
        visibleUserIds.add(committed.previousOwnerUserId)
      }
      if (plan.nextOwner !== null) visibleUserIds.add(plan.nextOwner)
      for (const userId of committed.previousMemberUserIds) visibleUserIds.add(userId)
      for (const userId of plan.nextMembers.keys()) visibleUserIds.add(userId)
      tasksListBroadcaster.broadcast(
        TASKS_LIST_CHANNEL,
        { type: 'employee-case.members.changed', caseId: row.id },
        { kind: 'employee-case.members-changed-audience', caseId: row.id, visibleUserIds },
      )
      return await getCaseMembers(actor, runtime, { ...row, ownerUserId: plan.nextOwner })
    },
    assertMembersUsersActive: assertActiveMembers,
    mountAcl({ app, type, base, load, notFoundCode }) {
      mountAclEndpoints(app, {
        type,
        base,
        param: 'id',
        load,
        canView: (actor, row) =>
          input.resourceCatalog.authorization.canViewResource(actor, type, row),
        read: (actor, row) => input.acl.getResourceAcl(actor, type, row),
        update: (actor, row, body, updatedAt) =>
          input.acl.updateResourceAcl(actor, type, row, body, {
            ...(updatedAt === undefined ? {} : { updatedAt }),
          }),
        ...(notFoundCode === undefined ? {} : { notFoundCode }),
      })
    },
  } satisfies DigitalEmployeeRoutePersistence)
}

/** SQLite compatibility composition used by direct `createApp({ db })` tests. */
function composeSqliteApiRouteMounts(
  deps: SqliteComposedAppDeps,
  identityAccess: IdentityAccessModule & IntegrationTriggerIdentityAccess,
  identityUserOperations: IdentityUserOperations,
  systemOperations: SystemOperationsModule,
  mcpRuntimeTests: McpRuntimeTestService,
  agentCatalog: AgentCatalogModule,
  mcpCatalog: McpCatalogModule,
  mcpProbeStore: ReturnType<typeof composeSqliteMcpProbeStore>,
  pluginCatalog: PluginCatalogModule,
  skillCatalog: SkillCatalogModule,
  workflowCatalog: WorkflowCatalogModule,
  workgroupCatalog: WorkgroupCatalogModule,
  resourcePackageCatalog: ComposedResourcePackageCatalog | null,
  providerResourceCatalog: ReturnType<typeof composeSqliteResourceCatalog>,
  resourceScopeAuthorization: ResourceScopeAuthorizationBinding,
  agentResourceIntegrity: ReturnType<typeof composeSqliteAgentResourceIntegrity>,
  overviewQuery: OverviewRouteQuery,
  intentApply: IntentApplyOperations,
  taskExecutionPersistence: ReturnType<typeof createSqliteTaskExecutionPersistence>,
): AppApiRouteMounts {
  const appHome = deps.appHome ?? Paths.root
  const inputArtifacts = createEmployeeInputArtifactStore(
    join(appHome, 'artifacts', 'employee-inputs'),
  )
  const developmentDelivery = buildDevelopmentDeliveryDeps(deps.developmentDeliveryProvider)
  const repositoryTransportModule = deps.repositoryTransport
  const repositoryWorkspaceStore = deps.repositoryWorkspaceStore
  const codeHostConnections = deps.codeHostConnections
  const repositoryPublicationTransport = deps.repositoryPublicationTransport
  const schedulerDriver = deps.schedulerDriver
  const codeWorkspace = composeSqliteLegacyCodeReadProviders(deps.db).workspace
  const taskRouteOperations = createSqliteTaskRouteOperations({
    db: deps.db,
    collaboration: deps.collaborationContext,
    recovery: taskExecutionPersistence.recoveryAdministration,
    startDepsFor: (actor) =>
      buildStartTaskDeps(
        deps.db,
        schedulerDriver,
        deps.configPath,
        actor.user.id,
        deps.secretBox,
        identityAccess,
      ),
    multipart: {
      ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
      configPath: deps.configPath,
      schedulerDriver,
      identityAccess: Object.freeze({
        directAuthority: identityAccess.directAuthority,
        taskExecutionResources: identityAccess.taskExecutionResources,
      }),
    },
    resourceAuthorityFor: (actor) =>
      Object.freeze({
        actor,
        authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
        resources: identityAccess.taskExecutionResources,
      }),
    assertWorkflowLaunchable: (workflow) => assertWorkflowSnapshotLaunchable(deps.db, workflow),
    appHome,
  })
  const routeDeps = {
    ...deps,
    identityAccess,
    repositoryPublicationTransport,
    schedulerDriver,
    operations: taskRouteOperations,
    taskExecutionReadModels: deps.taskExecutionReadModels,
    taskRecoveryOperations: taskExecutionPersistence.recoveryAdministration,
    codeWorkspace,
    repositoryWorkspace: repositoryWorkspaceStore,
    changeNarrative: {
      async requireMember(actor: Actor, taskId: string) {
        const access = await resolveCollaborationTaskAccess(deps.collaborationContext, {
          actor,
          taskId,
        })
        if (access.task === null) {
          throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        }
        if (access.actorRole === null) {
          throw new ForbiddenError(
            'not-task-member',
            'only task members or an actor with the required global task authority can do this',
          )
        }
      },
      resolveRuntime: ({
        runtimeName,
        defaultRuntime,
      }: {
        readonly runtimeName: string | null
        readonly defaultRuntime: string | null
      }) => deps.runtimeRegistry.resolveRuntimeByName(runtimeName ?? defaultRuntime),
    },
    collaborationContext: deps.collaborationContext,
  }
  const approvalGateway = composeSqliteApprovalGatewayRunner(deps.db)
  const developmentWorkspace = composeSqliteDevelopmentEmployeeWorkspace({
    db: deps.db,
    appHome,
    reactionRounds: createEmployeeReactionRoundQueries(deps.db),
    inputArtifacts,
    repositoryPreparation: createDevelopmentWorkspaceRepositoryPreparation({
      store: repositoryWorkspaceStore,
      appHome,
      ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
    }),
    sourceControl: bindEmployeeCaseWorkspaceParticipant({
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
  })
  const executionContracts = deps.executionContracts
  const eventCenter =
    deps.digitalEmployeeEventCenter ??
    composeApplicationEventCenter(deps, deps.developmentDeliveryProvider)
  const digitalEmployeeAgentTemplates =
    deps.digitalEmployeeAgentTemplates ??
    composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant(
      deps.db,
      composeDigitalEmployeeAgentTemplateCatalogParticipant,
    )
  const digitalEmployee = composeDigitalEmployee({
    db: deps.db,
    appHome,
    typePackages: [developmentEmployeeTypePackage],
    typePackageDriftPolicy: deps.digitalEmployeeTypePackageDriftPolicy,
    ...(deps.digitalEmployeePlatformTools === undefined
      ? {}
      : { platformTools: deps.digitalEmployeePlatformTools }),
    executionContracts,
    retryLimits: {
      current() {
        const config = loadConfig(deps.configPath)
        return {
          defaultNodeRetries: config.defaultNodeRetries,
          sessionRestartBudget: config.sessionRestartBudget,
        }
      },
    },
    inputArtifacts,
    connectionCatalog: composeSqliteDevelopmentToolConnectionCatalog(deps.db),
    runtime: {
      eventCenter: eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      detailProjectionParticipants:
        deps.digitalEmployeeCaseDetailProjection === undefined
          ? []
          : [deps.digitalEmployeeCaseDetailProjection],
      execution: createReactionExecutionAdapter(
        composeDigitalEmployeeExecution({
          db: deps.db,
          appHome,
          startDeps: buildStartTaskDeps(
            deps.db,
            schedulerDriver,
            deps.configPath,
            SYSTEM_USER_ID,
            deps.secretBox,
            deps.identityAccess,
          ),
          workspace: developmentWorkspace,
          executionContracts,
        }),
      ),
      platformWorkItems: composeSqliteDevelopmentEmployeePlatformWorkItems({
        reactionRounds: createEmployeeReactionRoundQueries(deps.db),
        db: deps.db,
        appHome,
        approvalGateway,
        ...developmentDelivery,
        conflictMerge: bindConflictMergeParticipant(),
        sourceControl: {
          ...bindChangeCandidateParticipant(),
          ...bindCandidateDeliveryParticipant({
            publicationTransport: repositoryPublicationTransport,
          }),
          ...bindEmployeeCaseWorkspaceParticipant({
            publicationTransport: repositoryPublicationTransport,
          }),
        },
      }),
    },
  })
  if (deps.digitalEmployeeWorkStart !== undefined && digitalEmployee.runtime !== null) {
    deps.digitalEmployeeWorkStart.bind({
      async launch(input) {
        const result = await digitalEmployee.runtime!.commands.launchWork({
          employeeId: input.employeeId,
          intake: input.intake,
          actorUserId: input.actorUserId,
          eventOrigin: input.origin,
        })
        return { caseId: result.caseRef.id }
      },
    })
  }
  if (digitalEmployee.runtime === null) {
    throw new Error('task catalog requires the digital employee runtime')
  }
  deps.developmentActivityWorker.bind(digitalEmployee.runtime.worker)
  const taskCatalog = composeTaskCatalog({
    sources: [
      ...composeTaskExecutionCatalogSources(deps.db),
      composeDigitalEmployeeTaskCatalogSource(digitalEmployee.runtime),
    ],
  })
  const developmentActivityOperations = deps.developmentActivityOperations
  const developmentConfigOperations = deps.developmentConfigOperations
  const developmentMissionOperations = deps.developmentMissionOperations
  const databaseMigration = deps.databaseMigration
  const oidcProviders =
    deps.secretBox === undefined
      ? null
      : createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })
  const oidcIdentities = composeSqliteOidcIdentityOperations({
    db: deps.db,
    identityAccess,
  })
  const memoryCatalog =
    deps.memoryOperations.catalog ??
    composeSqliteMemoryCatalogOperations({
      db: deps.db,
      contexts: identityAccess.contexts,
      authorization: resourceScopeAuthorization,
    })
  const agentLaunchResources = Object.freeze({
    resources: composeSqliteAgentLaunchResourceOperations(deps.db),
    integrity: agentResourceIntegrity.launch,
  })
  const taskRouteLaunch =
    deps.taskRouteLaunch ??
    createSqliteTaskRouteLaunchOperations({
      db: deps.db,
      configPath: deps.configPath,
      executionFor: (actor) => ({
        ...buildStartTaskDeps(
          deps.db,
          schedulerDriver,
          deps.configPath,
          actor.user.id,
          deps.secretBox,
          identityAccess,
        ),
        agentLaunchResources,
      }),
    })
  const workgroupTaskRoom = composeSqliteWorkgroupTaskRoom({
    db: deps.db,
    configPath: deps.configPath,
    schedulerDriver,
    taskRecoveryOperations: taskExecutionPersistence.recoveryAdministration,
  })
  const scheduledTaskRuntime = composeSqliteScheduledTaskRuntime({
    db: deps.db,
    resources: composeIntegrationTriggerResourceBinding(
      { canViewResourceInTx, assertNotBuiltin },
      composeDigitalEmployeeIntegrationTriggerParticipant,
    ),
    validation: Object.freeze({
      assertWorkflowLaunchable: (workflow) => assertWorkflowSnapshotLaunchable(deps.db, workflow),
      assertAgentIntegrity: (agentIds) =>
        agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
    } satisfies Parameters<typeof composeSqliteScheduledTaskRuntime>[0]['validation']),
    resourceAclChanged: () => triggerRevalidation('resource-acl-changed'),
  })
  const scheduledIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
  })
  const scheduledLaunch =
    deps.buildScheduleLaunch ??
    buildScheduleLaunch(
      deps.db,
      schedulerDriver,
      deps.configPath,
      identityAccess,
      agentLaunchResources,
    )
  const webhookEndpointService =
    deps.secretBox === undefined
      ? null
      : composeSqliteWebhookEndpointServiceDependencies({
          db: deps.db,
          configPath: deps.configPath,
          secretBox: deps.secretBox,
        })
  const webhookTriggerService = composeSqliteWebhookTriggerServiceDependencies(
    deps.db,
    deps.configPath,
    scheduledTaskRuntime.operations,
  )
  const webhookDeliveryRuntime = composeSqliteWebhookDeliveryRuntime(deps.db)
  const capabilityTemplatePersistence = createSqliteCapabilityTemplatePersistence(deps.db)
  const capabilityTemplateAccess = Object.freeze({
    filterVisible: (actor, rows) => filterVisibleRows(deps.db, actor, 'capability_template', rows),
    canView: (actor, row) => canViewResource(deps.db, actor, 'capability_template', row),
    requireEdit: (actor, row) => requireResourceEdit(deps.db, actor, 'capability_template', row),
    requireGovern: (actor, row) =>
      requireResourceGovern(deps.db, actor, 'capability_template', row),
    assertNameUnchangedForEditor,
  } satisfies Parameters<typeof composeSqliteCapabilityTemplateOperations>[0]['access'])
  const capabilityTemplateAcl: CapabilityTemplateRouteDeps['capabilityTemplateAcl'] = {
    load: (id) => capabilityTemplatePersistence.load(id),
    canView: (actor, row) => canViewResource(deps.db, actor, 'capability_template', row),
    read: (actor, row) => getResourceAcl(deps.db, actor, 'capability_template', row),
    update: (actor, row, body, updatedAt) =>
      updateResourceAcl(deps.db, actor, 'capability_template', row, body, {
        ...(updatedAt === undefined ? {} : { updatedAt }),
      }),
  }
  const capabilityTemplateRouteDeps = Object.freeze({
    codeHistoryQueries: deps.codeHistoryQueries,
    capabilityTemplates: composeSqliteCapabilityTemplateOperations({
      db: deps.db,
      access: capabilityTemplateAccess,
    }),
    capabilityTemplateAcl: Object.freeze(capabilityTemplateAcl),
  } satisfies CapabilityTemplateRouteDeps)
  const intentAuthorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
  const intentCatalogActors = new WeakMap<object, Actor>()
  const intentResourceCatalogFor = composeIntentResourceCatalogFor({
    query: providerResourceCatalog.createQuery({
      resolveActor(context) {
        const actor = intentCatalogActors.get(context)
        if (actor === undefined) throw new Error('intent-resource-catalog-context-not-bound')
        return actor
      },
    }),
    contextFor(actor) {
      const context = identityAccess.contexts.queryFromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      intentCatalogActors.set(context, actor)
      return context
    },
    authorityFor: intentAuthorityFor,
    catalogs: {
      agents: agentCatalog.queries,
      skills: skillCatalog.queries,
      skillFiles: skillCatalog.fileQueries,
      mcps: mcpCatalog.queries,
      plugins: pluginCatalog.queries,
      workflows: workflowCatalog.queries,
      workgroups: workgroupCatalog.queries,
    },
  })
  const intentPersistence = composeSqliteIntentPersistence({
    db: deps.db,
    contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
  })
  const intentPlatformInventory = composeIntentPlatformInventoryParticipant({
    authorityFor: intentAuthorityFor,
    capabilityTemplates: capabilityTemplateRouteDeps.capabilityTemplates,
    developmentConfig: developmentConfigOperations,
    digitalEmployee: composeDigitalEmployeePlatformInventoryParticipant({
      queries: digitalEmployee.queries,
      access: providerResourceCatalog.authorization,
    }),
  })
  const intentDumpAuxiliaryBase = composeIntentDumpAuxiliaryQueries({
    persistence: intentPersistence,
    platformInventory: intentPlatformInventory,
  })
  const intentDumpAuxiliary = Object.freeze({
    ...intentDumpAuxiliaryBase,
    runtimeInventory: Object.freeze({
      ...intentDumpAuxiliaryBase.runtimeInventory,
      async resolveDefault() {
        const runtime = await intentPersistence.resolveIntentRuntime(
          loadConfig(deps.configPath).defaultRuntime ?? 'opencode',
        )
        return { name: runtime.name, protocol: runtime.protocol }
      },
    }),
  })
  const intentSessionRoutes = Object.freeze({
    configPath: deps.configPath,
    identityAccess,
    directAuthority: identityAccess.directAuthority,
    intentApply,
    intentPersistence,
    intentTurnRuntime: Object.freeze({
      runtimeResolver: composeIntentTurnRuntimeResolver(intentPersistence),
      dumpAuxiliary: intentDumpAuxiliary,
    }),
    resourceCatalogFor: intentResourceCatalogFor,
    ...(deps.intentTestDependencies?.runFn === undefined
      ? {}
      : { runTurn: deps.intentTestDependencies.runFn }),
  } satisfies IntentSessionRouteDependencies)
  const digitalEmployeeAclIdentityProviders = createDigitalEmployeeResourceCatalogAclProviders(
    deps.db,
  )
  const digitalEmployeeAclIdentityFor = (type: DigitalEmployeeAclResourceType) => {
    switch (type) {
      case 'employee_definition':
        return digitalEmployeeAclIdentityProviders.employeeDefinition
      case 'employee_tool':
        return digitalEmployeeAclIdentityProviders.employeeTool
      case 'employee_job_template':
        return digitalEmployeeAclIdentityProviders.employeeJobTemplate
      default: {
        const exhaustive: never = type
        return exhaustive
      }
    }
  }
  const digitalEmployeePersistence = composeDigitalEmployeeRoutePersistence({
    identityAccess,
    resourceCatalog: providerResourceCatalog,
    acl: Object.freeze({
      getResourceAcl: (actor, type, row) =>
        getResourceAcl(deps.db, actor, type, row, digitalEmployeeAclIdentityFor(type)),
      updateResourceAcl: (actor, type, row, body, options) =>
        updateResourceAcl(deps.db, actor, type, row, body, {
          ...options,
          identityPersistence: digitalEmployeeAclIdentityFor(type),
        }),
    }),
  })
  const missionInputUploads = composeSqliteMissionInputUploadOperations({ db: deps.db, appHome })
  const collaborationRouteOperations = composeSqliteCollaborationRouteOperations({
    db: deps.db,
    context: deps.collaborationContext,
  })
  const collaborationTaskAccess = createSqliteCollaborationTaskAccessPort(deps.db)
  const taskClarifyDirectiveRoutes = Object.freeze({
    operations: composeTaskClarifyDirectiveRouteOperations(deps.collaborationContext),
  })
  const worktreeFiles = Object.freeze({
    store: repositoryWorkspaceStore,
    canViewTask: async (actor, task) =>
      (await collaborationTaskAccess.resolveTask(actor, task.id)).visible,
  } satisfies WorktreeFilesRouteDeps)
  const fusionOperations = composeSqliteFusionOperations({
    db: deps.db,
    appHome,
    memories: memoryCatalog,
    tasks: createSqliteFusionEngineTaskOperations({
      db: deps.db,
      appHome,
      schedulerDriver,
      startDeps: buildStartTaskDeps(
        deps.db,
        schedulerDriver,
        deps.configPath,
        SYSTEM_USER_ID,
        deps.secretBox,
        identityAccess,
      ),
    }),
  })
  return Object.freeze({
    config: (app) =>
      mountConfigRoutes(app, {
        configPath: deps.configPath,
        runtimeRegistry: deps.runtimeRegistry,
        runtimeTests: mcpRuntimeTests,
        concurrencyHotApply: deps.configConcurrencyHotApply,
      }),
    maintenance: (app) => mountMaintenanceRoutes(app, deps),
    daemon: (app) => mountDaemonRoutes(app, deps),
    plantuml: (app) => mountPlantumlRoutes(app, deps),
    runtime: (app) =>
      mountRuntimeRoutes(app, {
        configPath: deps.configPath,
        runtimeRegistry: deps.runtimeRegistry,
      }),
    runtimes: (app) =>
      mountRuntimesRoutes(app, {
        configPath: deps.configPath,
        runtimeRegistry: deps.runtimeRegistry,
        runtimeTests: mcpRuntimeTests,
        ...(deps.runtimeDiagnosticTestDependencies === undefined
          ? {}
          : { runtimeDiagnosticTestDependencies: deps.runtimeDiagnosticTestDependencies }),
      }),
    overview: (app) =>
      mountOverviewRoutes(
        app,
        {
          directAuthority: identityAccess.directAuthority,
        },
        overviewQuery,
      ),
    agents: (app) =>
      mountAgentRoutes(app, {
        queries: agentCatalog.queries,
        referenceQueries: agentCatalog.referenceQueries,
        dependencyQueries: agentCatalog.dependencyQueries,
        resourceIntegrityQueries: agentCatalog.resourceIntegrityQueries,
        importQueries: agentCatalog.importQueries,
        operations: agentCatalog.operations,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        listDigitalEmployeeTemplates: () =>
          listDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates),
        taskLaunch: taskRouteLaunch.agent,
      }),
    mcps: (app) =>
      mountMcpRoutes(app, {
        queries: mcpCatalog.queries,
        operations: mcpCatalog.operations,
        aclIdentity: mcpCatalog.participants.aclIdentity,
        probeStore: mcpProbeStore,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        runtimeTests: mcpRuntimeTests,
      }),
    plugins: (app) =>
      mountPluginRoutes(app, {
        queries: pluginCatalog.queries,
        operations: pluginCatalog.operations,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    skills: (app) =>
      mountSkillRoutes(app, {
        fileCommands: skillCatalog.fileCommands,
        versionCommands: skillCatalog.versionCommands,
        queries: skillCatalog.queries,
        fileQueries: skillCatalog.fileQueries,
        versionQueries: skillCatalog.versionQueries,
        operations: skillCatalog.operations,
        zipImport: skillCatalog.zipImport,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    repos: (app) => mountRepoRoutes(app, repositoryWorkspaceStore),
    cachedRepos: (app) => mountCachedRepoRoutes(app, deps, repositoryWorkspaceStore),
    repoGroups: (app) => mountRepoGroupRoutes(app, deps, repositoryWorkspaceStore),
    workflows: (app) =>
      mountWorkflowRoutes(app, deps, {
        queries: workflowCatalog.queries,
        validationQueries: workflowCatalog.validationQueries,
        operations: workflowCatalog.operations,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    workgroups: (app) =>
      mountWorkgroupRoutes(app, {
        queries: workgroupCatalog.queries,
        operations: workgroupCatalog.operations,
        resourceIntegrityQueries: agentResourceIntegrity.queries,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        taskLaunch: taskRouteLaunch.workgroup,
      }),
    resourcePackages: (app) => {
      if (resourcePackageCatalog === null) return
      registerResourcePackageRoutes(app, {
        catalog: resourcePackageCatalog,
        commandContextFor: (actor) =>
          identityAccess.contexts.fromAuthority(
            directRequestAuthority(identityAccess.directAuthority, actor),
            'http',
          ),
        queryContextFor: (actor) =>
          identityAccess.contexts.queryFromAuthority(
            directRequestAuthority(identityAccess.directAuthority, actor),
            'http',
          ),
      })
    },
    workgroupTasks: (app) =>
      mountWorkgroupTaskRoutes(app, {
        module: workgroupTaskRoom,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    tasks: (app) => mountTaskRoutes(app, routeDeps),
    taskCatalog: (app) => mountTaskCatalogRoutes(app, taskCatalog),
    taskArchive: (app) =>
      mountTaskArchiveRoutes(app, {
        configPath: deps.configPath,
        taskArchiveMaintenance: createSqliteTaskArchiveMaintenanceCommand(deps.db),
      }),
    maintenanceDisk: (app) => mountMaintenanceDiskRoutes(app, deps.maintenanceDisk),
    scheduledTasks: (app) =>
      mountScheduledTaskRoutes(app, {
        identityAccess: scheduledIdentityAccess,
        scheduledTaskRuntime,
        buildScheduleLaunch: scheduledLaunch,
        getDefaultRuntime: () => loadConfig(deps.configPath).defaultRuntime ?? null,
      }),
    webhookEndpoints: (app) => {
      if (webhookEndpointService === null) return
      mountWebhookEndpointRoutes(app, { webhookEndpointService })
    },
    codeHosts: (app) => mountCodeHostRoutes(app, deps, codeHostConnections),
    repositoryTransportCredentials: (app) => {
      if (repositoryTransportModule === null) return
      mountAccountRepositoryTransportCredentialRoutes(app, deps, {
        credentials: repositoryTransportModule.ownCredentials,
        currentSubjects: identityAccess.resolveAuthority,
      })
    },
    code: (app) => mountCodeRoutes(app, deps.codeHistoryQueries),
    capabilityTemplates: (app) => mountCapabilityTemplateRoutes(app, capabilityTemplateRouteDeps),
    eventCenter: (app) => mountEventCenterRoutes(app, eventCenter),
    executionContracts: (app) => mountExecutionContractRoutes(app, executionContracts),
    digitalEmployees: (app) =>
      mountDigitalEmployeeRoutes(
        app,
        digitalEmployeePersistence,
        digitalEmployee,
        developmentActivityOperations,
        identityAccess.directAuthority,
      ),
    developmentConfig: (app) =>
      mountDevelopmentConfigRoutes(
        app,
        composeSqliteDevelopmentConfigAclRoutes(deps.db, deps.developmentAdapterAclIdentity),
        developmentConfigOperations,
        identityAccess.directAuthority,
      ),
    developmentMissions: (app) =>
      mountDevelopmentMissionRoutes(
        app,
        developmentMissionOperations,
        identityAccess.directAuthority,
      ),
    missionInputUploads: (app) => mountMissionInputUploadRoutes(app, missionInputUploads),
    webhookTriggers: (app) =>
      mountWebhookTriggerRoutes(app, { webhookTriggerService }, scheduledIdentityAccess),
    webhookDeliveries: (app) =>
      mountWebhookDeliveryRoutes(app, {
        webhookDeliveryRuntime,
        ...(deps.digitalEmployeeEventCenter === undefined
          ? {}
          : { digitalEmployeeEventCenter: deps.digitalEmployeeEventCenter }),
        ...(deps.webhookDispatcher === undefined
          ? {}
          : { webhookDispatcher: deps.webhookDispatcher }),
        ...(deps.webhookTerminalControl === undefined
          ? {}
          : { webhookTerminalControl: deps.webhookTerminalControl }),
      }),
    backup: (app) => mountBackupRoutes(app, systemOperations, identityAccess),
    restore: (app) => mountRestoreRoutes(app, systemOperations, identityAccess),
    ...(databaseMigration === undefined
      ? {}
      : {
          databaseMigration: (app: Hono) =>
            mountDatabaseMigrationRoutes(app, databaseMigration.operations, identityAccess),
        }),
    worktreeFiles: (app) => mountWorktreeFilesRoutes(app, worktreeFiles),
    portArtifacts: (app) => mountPortArtifactRoutes(app, deps),
    reviews: (app) => mountReviewRoutes(app, collaborationRouteOperations, appHome),
    clarify: (app) => mountClarifyRoutes(app, collaborationRouteOperations),
    taskQuestions: (app) => mountTaskQuestionRoutes(app, collaborationRouteOperations),
    taskClarifyDirective: (app) => mountTaskClarifyDirectiveRoutes(app, taskClarifyDirectiveRoutes),
    fusion: (app) =>
      mountFusionRoutes(app, {
        operations: fusionOperations,
        configPath: deps.configPath,
        directAuthority: identityAccess.directAuthority,
      }),
    intentSessions: (app) => mountIntentSessionRoutes(app, intentSessionRoutes),
    memories: (app) =>
      mountMemoryRoutes(app, memoryCatalog, {
        contexts: identityAccess.contexts,
        directAuthority: identityAccess.directAuthority,
      }),
    memoryDistillJobs: (app) => mountMemoryDistillJobRoutes(app, routeDeps),
    taskFeedback: (app) => mountTaskFeedbackRoutes(app, deps),
    auth: (app) =>
      mountAuthRoutes(app, { configPath: deps.configPath }, identityAccess, {
        auth: deps.authRuntime,
        listIdentitiesForUser: (userId) => oidcIdentities.listIdentitiesForUser(userId),
        listTokenAuditForUser: (userId) => listTokenAuditForUser(deps.db, userId),
      }),
    oidcAuth: (app) =>
      mountOidcAuthRoutes(
        app,
        { configPath: deps.configPath },
        {
          auth: deps.authRuntime,
          providers: oidcProviders,
          identities: oidcIdentities,
        },
      ),
    oidc: (app) => mountOidcRoutes(app, { auth: deps.authRuntime, providers: oidcProviders }),
    users: (app) =>
      mountUserRoutes(
        app,
        { auth: deps.authRuntime, listTokenAudit: () => listTokenAudit(deps.db) },
        {
          contexts: identityAccess.contexts,
          directAuthority: identityAccess.directAuthority,
          operations: identityUserOperations,
        },
      ),
    docs: (app) => mountDocsRoutes(app, deps),
  } satisfies AppApiRouteMounts)
}

/**
 * Every `/api/*` route in its canonical order.  Provider composition supplies
 * closed bindings, but cannot add, remove or reorder route domains.
 */
export function mountApiRoutes(app: Hono, deps: ComposedAppDeps): void {
  const routes = deps.apiRoutes
  routes.config(app)
  routes.maintenance(app)
  routes.daemon(app)
  routes.plantuml(app)
  routes.runtime(app)
  routes.runtimes(app)
  routes.overview(app)
  routes.agents(app)
  routes.mcps(app)
  routes.plugins(app)
  routes.skills(app)
  routes.repos(app)
  routes.cachedRepos(app)
  routes.repoGroups(app)
  routes.workflows(app)
  routes.workgroups(app)
  routes.resourcePackages(app)
  routes.workgroupTasks(app)
  routes.tasks(app)
  routes.taskCatalog(app)
  routes.taskArchive(app)
  routes.maintenanceDisk(app)
  routes.scheduledTasks(app)
  routes.webhookEndpoints(app)
  routes.codeHosts(app)
  routes.repositoryTransportCredentials(app)
  routes.code(app)
  routes.capabilityTemplates(app)
  routes.eventCenter(app)
  routes.executionContracts(app)
  routes.digitalEmployees(app)
  routes.developmentConfig(app)
  routes.developmentMissions(app)
  routes.missionInputUploads(app)
  routes.webhookTriggers(app)
  routes.webhookDeliveries(app)
  routes.backup(app)
  routes.restore(app)
  routes.databaseMigration?.(app)
  for (const alias of SYSTEM_OPERATION_ALIASES) registerOperationAlias(alias)
  routes.worktreeFiles(app)
  routes.portArtifacts(app)
  routes.reviews(app)
  routes.clarify(app)
  routes.taskQuestions(app)
  routes.taskClarifyDirective(app)
  routes.fusion(app)
  routes.intentSessions(app)
  routes.memories(app)
  routes.memoryDistillJobs(app)
  routes.taskFeedback(app)
  routes.auth(app)
  routes.oidcAuth(app)
  routes.oidc(app)
  routes.users(app)
  routes.docs(app)
}

/** Build the HTTP/MCP application from already-selected provider ports. */
export function createComposedApp(deps: ComposedAppDeps): Hono {
  const log = createLogger('http')
  const app = new Hono()

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    log.debug('req', { method: c.req.method, path: c.req.path, status: c.res.status, ms })
  })

  deps.publicRoutes.health(app)
  deps.publicRoutes.wellKnown(app)
  deps.publicRoutes.webhookIngress(app)

  app.use(
    '/api/*',
    multiAuth({
      auth: deps.core.authRuntime,
      daemonToken: deps.token,
      identityAccess: deps.core.identityAccess,
    }),
  )
  app.use('/api/*', async (c, next) => {
    await next()
    const actor = tryActorOf(c)
    if (actor === null || actor.source !== 'pat' || c.req.path === '/api/mcp') return
    // RFC-349 T10: the migration-control path stays reachable while the source
    // is frozen, so this projection would be the request path's other writer.
    if (!deps.core.sourceWriteWindow.writable()) return
    void deps.core.tokenCallAudit.record({
      actor,
      channel: 'rest',
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      deletedSnapshot: takeDeleteSnapshot(c),
    })
  })

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/whoami',
      permissions: [],
      publicReason:
        'identity self-introspection; any authenticated actor may ask who it is, and a token needs it because RFC-247 D6 closes /api/auth/me to tokens',
      tokenAccess: 'allow',
      summary: 'Resolved actor identity for the current credential',
    },
    (c) => {
      const actor = actorOf(c)
      return c.json({
        ok: true,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        user: {
          id: actor.user.id,
          username: actor.user.username,
          displayName: actor.user.displayName,
          role: actor.user.role,
          status: actor.user.status,
        },
        source: actor.source,
      })
    },
  )

  mountApiRoutes(app, deps)
  mountMcpTransport(app, {
    tokenCallAudit: deps.core.tokenCallAudit,
    configPath: deps.configPath,
    operationInvokerFor: (actor) =>
      createBoundOperationInvoker(
        app,
        directMcpOperationAuthority(deps.core.identityAccess.directAuthority, actor),
      ),
  })

  assertRouteMetaCoverage(app.routes.map((route) => ({ method: route.method, path: route.path })))
  assertOperationCatalogClosed()
  app.onError(errorHandler)

  if (IS_EMBEDDED) {
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
        return c.json(
          { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
          404,
        )
      }
      const response = await getEmbeddedFrontendResponse(c.req.path)
      if (response !== null) return response
      return c.json(
        { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
        404,
      )
    })
  }

  app.notFound((c) =>
    c.json({ ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` }, 404),
  )
  return app
}

export function createApp(deps: AppDeps): Hono
export function createApp(deps: ComposedAppDeps): Hono
export function createApp(deps: AppDeps | ComposedAppDeps): Hono {
  return createComposedApp('apiRoutes' in deps ? deps : composeSqliteAppDeps(deps))
}
