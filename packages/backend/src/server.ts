import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { composeLocalExecutionAuthority } from '@/modules/system-operations/composition'
import { composeDaemonIntentModules, type DaemonIntentModules } from './cli/daemonModules/intent'
import {
  composeDaemonDigitalEmployeeModules,
  type DaemonDigitalEmployeeModules,
} from '@/cli/daemonModules/digitalEmployee'
import {
  composeDaemonDevelopmentAutomationModules,
  type DaemonDevelopmentAutomationModules,
} from '@/cli/daemonModules/developmentAutomation'
import {
  composeDaemonTaskExecutionModules,
  type DaemonTaskExecutionModules,
} from '@/cli/daemonModules/taskExecution'
import { DAEMON_TASK_EXECUTION_ADAPTERS } from '@/cli/daemonModules/adapters'
import { finishClaimedWebhookWorkspacePrune, materializingSpaces } from '@/services/gc'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import {
  composeDaemonScheduledTaskModules,
  type DaemonScheduledTaskModules,
} from '@/cli/daemonModules/scheduledTasks'
import {
  composeDaemonIntegrationModules,
  type DaemonIntegrationModules,
} from '@/cli/daemonModules/integration'
import { composeDaemonFusionModules, type DaemonFusionModules } from '@/cli/daemonModules/fusion'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  standaloneModuleAdapters,
} from '@/cli/daemonModules/adapters'
import { composeDaemonMemoryModules, type DaemonMemoryModules } from '@/cli/daemonModules/memory'
import {
  composeDaemonObservationModules,
  type DaemonObservationModules,
} from '@/cli/daemonModules/observation'
import {
  composeDaemonProviderCore,
  type DaemonProviderCore,
  type SelectedDaemonProviderCore,
} from '@/cli/daemonModules/providerCore'
import {
  composeDaemonRepositoryCredentials,
  type DaemonRepositoryCredentials,
} from '@/cli/daemonModules/repositoryCredentials'
import {
  composeDaemonResourceCatalogModules,
  type DaemonResourceCatalogModules,
} from '@/cli/daemonModules/resourceCatalog'
import { composeDaemonRealtimePolicy } from '@/cli/daemonRealtimePolicy'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import { composeClarifyFollowupGenerator } from '@/modules/task-execution/composition/clarifyFollowupGenerator'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type {
  ApprovalAdapterBinding,
  PipelineAdapterBinding,
  RequirementAdapterBinding,
} from '@/modules/integration/public/participants'
import { createLocalDevelopmentAdapterEffects } from '@/modules/integration/composition/developmentAdapterProgram'
import type {
  EvidenceStagingFactory,
  PipelineStagingFactories,
} from '@/modules/development-automation/public/types'
import {
  createLocalEvidenceArtifactPort,
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
  createFileEvidenceDocumentCommands,
} from '@/modules/development-automation/composition/evidenceStaging'
import { assertEvidenceStagingFactory } from '@/modules/development-automation/public/participants'
import {
  composeLocalTaskRunRootSelection,
  composeTaskWorkspaceExcludeProfilesFor,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import {
  selectTaskRunRootSelection,
  type TaskRunRootSelection,
} from '@/modules/task-execution/composition/taskRunSelection'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import type {
  WorkspaceUploadContentFactory,
  IsolationWorkspaceFactory,
  RepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/types'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/composition'
import {
  selectWorkspaceUploadContentFactory,
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import {
  composePortArtifactOperations,
  selectPortArtifactOperations,
} from '@/modules/task-execution/composition/portArtifacts'
import type {
  PortArtifactContentEffects,
  PortArtifactOperations,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import { composeTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'
import {
  selectDevelopmentWorkspaceEffectBinding,
  type ActionWorkspaceEffects,
  type AutomationWorkspaceEffectsFactory,
} from '@/modules/development-automation/composition'
import type { ConflictMergeWorkspaceEffects } from '@/modules/source-control/public/types'
import type {
  RepositoryBaselineEffectsFactory,
  VerificationCommandEffectsFactory,
} from '@/modules/development-automation/composition'
import {
  composeRunObservation,
  type RunObservation,
} from '@/modules/run-observability/composition/runObservation'
import type { RuntimeProfileConfigurationCommands } from '@/modules/runtime-management/public/commands'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import type { HttpAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import { composeHttpAuthenticationMiddleware } from '@/modules/identity-access/composition/authentication'
import { composeWebhookIngressTransport } from '@/modules/integration/composition/webhookIngress'
import type {
  ApplicationConfigurationQueries,
  DaemonRuntimeQueries,
} from '@/modules/system-operations/public/queries'
import { selectDaemonRuntimeQueries } from '@/modules/system-operations/composition/daemonHostLifecycle'
import { bindExecutionAvailability } from '@/platform/http/executionAvailability'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { Hono } from 'hono'
import type {
  DatabaseRuntimeTelemetry,
  MaintenanceStatus,
  WorkflowRevision,
} from '@agent-workflow/shared'
import { join } from 'node:path'
import { actorOf, tryActorOf, type Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import { takeDeleteSnapshot } from '@/services/tokenAudit'
import { assertRouteMetaCoverage, registerRoute } from '@/routes/registry'
import type { DbClient } from '@/db/client'
import type {
  BuildScheduleLaunch,
  IntegrationTriggerResourceBinding,
} from '@/services/scheduledTasks'
import type { SmokeOptions, SmokeResult } from '@/services/runtimeSmoke'
import { getEmbeddedFrontendResponse, IS_EMBEDDED, type FrontendDeploymentMode } from '@/embed'
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
import { type WebhookDispatcher } from '@/services/webhook/dispatcherTypes'

import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import {
  createEventAutomationDelegatedContextBinding,
  type IdentityAccessRuntime,
} from '@/modules/identity-access/composition'

import type { CommandContext } from '@/modules/identity-access/public/participants'
import { type SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import { type PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import {
  composeWorkgroupTaskRoom,
  composeWorkgroupTaskRoomActiveUsers,
  composeWorkgroupTaskRoomDynamicWorkflow,
} from '@/modules/resource-catalog/composition/workgroupTaskRoom'

import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import {
  executionStatusOf,
  type SystemOperationsModule,
} from '@/modules/system-operations/composition'
import {
  composeDatabaseMigrationModule,
  type DatabaseMigrationModule,
} from '@/modules/system-operations/composition/databaseMigration'
import { SYSTEM_OPERATION_ALIASES } from '@/modules/system-operations/public/operations'
import {
  composeOidcIdentityOperations,
  composeOwnerIdentityQueries,
} from '@/modules/identity-access/composition/providerOperations'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { createOidcProvidersService } from '@/services/oidcProviders'
import type { LocalMcpDiagnosticsCompositionInput as McpDiagnosticsCompositionInput } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { McpDiagnosticsRuntime } from '@/modules/resource-catalog/composition/mcpDiagnostics'
import { mountMcpRoutes } from '@/routes/mcps'
import { mountMemoryRoutes } from '@/routes/memories'
import { mountMemoryDistillJobRoutes } from '@/routes/memoryDistillJobs'

import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'
import {
  composeRepositoryMirrors,
  createFileWorkspaceContentEffects,
  createWorkspaceContentScope,
  type EmployeeCaseWorkspaceEffectsFactory,
  type RepositoryMirrors,
  type WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
  type WorkspacePresenceQueries,
} from '@/modules/source-control/public/queries'
import type { ResourcePackageApplyActivityQuery } from '@/modules/resource-catalog/public/queries'
import {
  readCommittedReviewArtifactBody,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { mountTaskFeedbackRoutes } from '@/routes/taskFeedback'
import { mountOverviewRoutes } from '@/routes/overview'
import { composeResourceCatalogOverviewQuery } from '@/modules/resource-catalog/composition/resourceCatalogOverview'
import { composeSystemOverviewQuery } from '@/modules/system-operations/composition/overview'
import { mountOidcRoutes } from '@/routes/oidc'
import { mountOidcAuthRoutes } from '@/routes/oidc-auth'
import { mountPlantumlRoutes } from '@/routes/plantuml'
import { mountPluginRoutes } from '@/routes/plugins'
import { mountUserRoutes } from '@/routes/users'
import { mountRepoRoutes } from '@/routes/repos'
import { composeRuntimeProbeConfigFence } from '@/modules/runtime-management/composition/runtimeManagement'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import {
  mountRuntimeRoutes,
  mountRuntimesRoutes,
} from '@/modules/runtime-management/composition/runtimeRoutes'
import type {
  RuntimeModelQueries,
  RuntimeProfileQueries,
} from '@/modules/runtime-management/public/queries'
import type {
  RuntimeProfileCommands,
  RuntimeDiagnosticCommands,
} from '@/modules/runtime-management/public/commands'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import { mountSkillRoutes } from '@/routes/skills'
import { mountClarifyRoutes } from '@/routes/clarify'
import { mountTaskQuestionRoutes } from '@/routes/taskQuestions'
import { mountTaskClarifyDirectiveRoutes } from '@/routes/taskClarifyDirective'
import { mountFusionRoutes } from '@/modules/knowledge-evolution/inbound/fusionRoutes'
import { mountSkillProvenanceRoutes } from '@/modules/knowledge-evolution/inbound/skillProvenanceRoutes'
import {
  mountIntentSessionRoutes,
  type IntentSessionRouteDependencies,
} from '@/modules/intent/composition/routes'
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
import { mountCapabilityTemplateRoutes } from '@/routes/capabilityTemplates'
import { mountDevelopmentConfigRoutes } from '@/routes/developmentConfig'
import { mountDevelopmentMissionRoutes } from '@/routes/developmentMissions'
import { mountDigitalEmployeeRoutes } from '@/routes/digitalEmployees'
import { mountEventCenterRoutes } from '@/routes/eventCenter'
import { mountExecutionContractRoutes } from '@/routes/executionContracts'
import { mountMissionInputUploadRoutes } from '@/routes/missionInputUploads'
import { mountCodeRoutes } from '@/routes/code'
import { mountWebhookEndpointRoutes } from '@/routes/webhookEndpoints'
import { mountWebhookTriggerRoutes } from '@/routes/webhookTriggers'
import { mountWebhookDeliveryRoutes } from '@/routes/webhookDeliveries'
import { mountWorkflowRoutes } from '@/routes/workflows'
import { mountWorkgroupRoutes } from '@/routes/workgroups'
import { registerResourcePackageRoutes } from '@/routes/resourcePackages'
import { Paths } from '@/util/paths'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountWorktreeFilesRoutes } from '@/routes/worktree-files'
import { mountPortArtifactRoutes } from '@/routes/port-artifacts'
import { errorHandler, ForbiddenError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'

import type { DigitalEmployeePlatformToolCatalogParticipant } from '@/modules/digital-employee/public/types'
import { type MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composeLegacyCodeReadProviders } from '@/modules/code-capability/composition/legacyCodeReads'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/composition/codeReviewArtifacts'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import type { composeExecutionContract } from '@/modules/execution-contract/composition'
import { type CustomObserverProgramFactory } from '@/modules/event-center/composition'

import { type TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import type {
  NodeRunPromptContentEffects,
  NodeRunPromptOperations,
  TaskDeletionEffects,
  TaskExecutionReadModels,
} from '@/modules/task-execution/public/types'
import {
  composeNodeRunPromptOperations,
  selectNodeRunPromptOperations,
} from '@/modules/task-execution/composition/nodeRunPrompts'
import { createCollaborationTaskAccessPort } from '@/modules/collaboration/composition'
import { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'

import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { createResourcePackagePluginInstaller } from '@/services/resourcePackage/pluginInstallerAdapter'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
  type ResourcePackageSkillArtifactOwner,
  type ResourcePackagePluginArtifactOwner,
  type SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { setChildTaskBudgetCapacity } from '@/services/execution/childBudget'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { listDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import {
  type EvidenceDocumentCommands,
  type EvidenceArtifactPort,
  type AttemptContextStorePort,
} from '@/modules/development-automation/composition'

import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import {
  type RepositoryTransportCredentialModule,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'

import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'

export type {
  DaemonProviderCore,
  SelectedDaemonProviderCore,
} from '@/cli/daemonModules/providerCore'

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

export interface AppDeps {
  repositoryCredentials?: DaemonRepositoryCredentials
  resourceCatalogModules?: DaemonResourceCatalogModules
  observationModules?: DaemonObservationModules
  memoryModules?: DaemonMemoryModules
  intentModules?: DaemonIntentModules
  digitalEmployeeModules?: DaemonDigitalEmployeeModules
  developmentAutomationModules?: DaemonDevelopmentAutomationModules
  taskExecutionModules?: DaemonTaskExecutionModules<'sqlite'>
  repositoryPreparationEffects?: NonNullable<
    Parameters<typeof composeDaemonTaskExecutionModules>[0]['selection']['preparationEffects']
  >
  scratchWorkspaceEffects?: NonNullable<
    Parameters<typeof composeDaemonTaskExecutionModules>[0]['selection']['scratchEffects']
  >
  scheduledTaskModules?: DaemonScheduledTaskModules
  integrationModules?: DaemonIntegrationModules
  fusionModules?: DaemonFusionModules
  /** The same complete store selection serves skill editing and boot recovery. */
  skillContent?: SkillContentBinding
  employeePrograms?: ProgramArtifactPort
  employeeInputArtifacts?: EmployeeInputArtifactPort
  missionInputBlobs?: MissionInputBlobPersistence
  pluginInstaller?: PluginInstallerPort
  archivedNodeEvents?: TaskArchivedEventsReader
  intentArtifacts?: IntentArtifactSelection
  evidenceArtifacts?: EvidenceArtifactPort
  resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  resourcePackageSkillContent?: SkillPackageContentReader
  workspaceContent?: WorkspaceContentEffectsFactory
  workspaceUploads?: WorkspaceUploadContentFactory
  isolationWorkspaces?: IsolationWorkspaceFactory
  repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  repositoryBaselines?: RepositoryBaselineEffectsFactory
  verificationCommands?: VerificationCommandEffectsFactory
  customObserverPrograms?: CustomObserverProgramFactory
  automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  actionWorkspaceEffects?: ActionWorkspaceEffects
  conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  taskDeletionEffects?: TaskDeletionEffects
  nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  nodeRunPrompts?: NodeRunPromptOperations
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  portArtifacts?: PortArtifactOperations
  taskRunSelection?: TaskRunRootSelection
  developmentPurposes?: DevelopmentPurposeSelection
  runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  developmentPurposeRoot?: SelectedDevelopmentPurposeRoot
  workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  evidenceRead?: EvidenceReadBinding
  evidenceDocumentCommands?: EvidenceDocumentCommands
  attemptContext?: AttemptContextStorePort
  /** Selected archive store for standalone HTTP composition. */
  taskArchive?: TaskArchiveContentBinding
  /** SC presence facts selected once for root/child/continuation resume. */
  workspacePresence?: WorkspacePresenceQueries
  workspaceReads?: RepositoryWorkspaceReadQueries
  /**
   * RFC-349 bootstrap-selected provider core shared by HTTP, MCP, WebSocket
   * and background services. Individual fields below remain test seams; the
   * daemon supplies this aggregate so every consumer observes one provider.
   */
  providerCore?: DaemonProviderCore
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
  repositoryTransport?: RepositoryTransportCredentialModule
  /** Token required for /api/*. */
  token: string
  /** Absolute path to config.json (lets tests use a temp file). */
  configPath: string
  /** Selected live query shared by configuration consumers in this application. */
  configuration?: ApplicationConfigurationQueries
  /** One selected storage instance owns Settings writes and live reads. */
  applicationConfiguration?: ApplicationConfigurationBinding
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
  /** Selected current host facts; shared with startup readiness publication. */
  daemonRuntime?: DaemonRuntimeQueries
  /** RFC-370 v2 H7: bootstrap-selected execution authority; absent means standalone. */
  executionAuthority?: ExecutionAuthorityPort
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
  /** RFC-349 bootstrap-selected backup/restore administration module. */
  systemOperations?: SystemOperationsModule
  /**
   * RFC-349 provider-neutral execution-contract projection. Production
   * bootstrap injects the selected provider adapter once so HTTP and the
   * Digital Employee worker share the same application participant. Direct
   * createApp tests may omit it and retain the SQLite compatibility path.
   */
  executionContracts?: ReturnType<typeof composeExecutionContract>
  /**
   * Completed immutable platform-tool projection. Production composes this
   * asynchronously before HTTP assembly; the synchronous direct-test wrapper
   * may omit it and exercises the empty platform catalog explicitly.
   */
  digitalEmployeePlatformTools?: DigitalEmployeePlatformToolCatalogParticipant
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
  /** RFC-338: indexed/live projection from the off-thread maintenance owner. */
  maintenanceStatus?: () => MaintenanceStatus
  /** RFC-349: selected-provider mechanism telemetry, kept separate from request latency. */
  databaseTelemetry?: () => DatabaseRuntimeTelemetry
  /**
   * RFC-036 — AES-256-GCM seal/unseal helper.
   *
   * RFC-359 AC-1（plan §5gt）：**必填**。此前是可选的，于是这棵组合树里长出 11 处
   * `deps.secretBox === undefined ? … : …` 的容忍分支，以及它们下游一串可空值
   * （`oidcProviders` / `codeHostConnections` / `webhookEndpointService` /
   * `resourcePackageBinding` / `repositoryTransport`）。
   *
   * 那些分支**在生产里一条都到不了**：`cli/start.ts:1480` 在**选 provider 之前**就
   * 无条件 `createSecretBox(...)`（源码注释原话：needed by either selected composition），
   * 两个引擎的真实部署都必定带它。可选性唯一的服务对象是「省事不传的测试」，
   * 代价却是 PostgreSQL 根要求必填、SQLite 根不要求——一处纯粹的装配签名不对称
   * （`rfc221-login-policy-routes` 的注释早就把这条记成「正解是收成必填」）。
   */
  secretBox: SecretBox
  /** Test override; otherwise the integration bundle supplies the dispatcher. */
  webhookDispatcher?: WebhookDispatcher
  /** RFC-303 durable launch guard + terminal effect worker. */
  webhookTerminalControl?: MrTerminalControl
  /** Bun-dev only: serve the current type-package draft without rewriting its frozen DB row. */
  digitalEmployeeTypePackageDriftPolicy?: 'reject' | 'draft-overlay'
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
}
export type IntegrationTriggerIdentityAccess = IdentityAccessRuntime & {
  readonly integrationTriggerResources: IntegrationTriggerResourceBinding
  readonly taskExecutionResources: TaskExecutionResourceBinding
}

function withIntegrationTriggerResources(
  identityAccess: IdentityAccessRuntime,
  integrationTriggerResources: IntegrationTriggerResourceBinding,
  taskExecutionResources: TaskExecutionResourceBinding,
): IntegrationTriggerIdentityAccess {
  return Object.freeze({ ...identityAccess, integrationTriggerResources, taskExecutionResources })
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
  /** RFC-370 v3 V8 — hosted only: CrewStation's event delivery route. */
  readonly crewStationEvents?: AppRouteMount
}

/**
 * The route topology remains owned by this file.  Provider composition only
 * supplies closed mount bindings; `mountApiRoutes` invokes them below in one
 * fixed order for SQLite and PostgreSQL alike.
 */
export interface AppApiRouteMounts {
  readonly observability: AppRouteMount
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
  readonly skillProvenance: AppRouteMount
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
  readonly databaseMigration: AppRouteMount
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
/**
 * RFC-359 AC-10 —— 用**按 provider 索引的表**代替条件类型。
 *
 * 原来是 `TProvider extends 'postgresql' ? Pg… : …`：第三个 provider 进来会静默落进
 * false 分支、拿到 SQLite 那个模块类型，编译器一声不吭——正是本 RFC 要消灭的形状，
 * 只不过发生在类型层。
 *
 * 换成索引访问之后，`extends Record<DatabaseProvider, …>` 这条约束就是 forcing function：
 * 往 `DatabaseProvider` 里加一个成员，这个接口**立刻编译不过**，必须先回答「新 provider 的
 * system-operations 模块是哪一个」。
 */
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
  readonly configuration: ApplicationConfigurationQueries
  readonly authentication: HttpAuthenticationParticipant
  readonly core: TCore
  readonly publicRoutes: AppPublicRouteMounts
  readonly apiRoutes: AppApiRouteMounts
  readonly executionAuthority?: ExecutionAuthorityPort
}

/** The completed HTTP employee instance also serves this bootstrap WorkStart port. */
export interface SqliteAppComposition<
  TCore extends AppHttpProviderCore = AppHttpProviderCore,
> extends ComposedAppDeps<TCore> {
  readonly intentModules: DaemonIntentModules
  readonly digitalEmployeeModules: DaemonDigitalEmployeeModules
  readonly developmentAutomationModules: DaemonDevelopmentAutomationModules
  readonly taskExecutionModules: DaemonTaskExecutionModules<'sqlite'>
  readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  /**
   * RFC-359 —— 装配结果本来就在返回值里（`...runtimeDeps` 带出来的），只是类型上没声明。
   * 声明出来，测试夹具才能把「应用自己建的那一份」交给用例，而不是逼用例在外面再
   * `createTaskExecutionReadModels(db)` 建一份、再从 `AppDeps` 塞回去——那个形状把用例
   * 钉死在 SQLite 上（`PostgresqlApplicationInput` 没有、也不该有这个只服务测试的字段）。
   */
  readonly taskExecutionReadModels: TaskExecutionReadModels
  /** 同上：装配好的协作命令上下文，让夹具把它交给用例而不是逼用例重建。 */
  readonly collaborationContext: CollaborationRouteContext
  /**
   * RFC-359 —— 本进程**正在执行**的资源包 apply 的 journal id 快照。维护 Worker 拿它来
   * 决定哪些 journal 行不能回收：两台 apply 引擎合一前，SQLite 这一侧读的是 legacy
   * `services/bundle/apply` 的模块级集合；现在与 PostgreSQL 一样，读的是 apply 引擎自己的。
   */
  readonly resourcePackageApplyActivity: ResourcePackageApplyActivityQuery
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
  readonly webhookIngress: ReturnType<typeof composeWebhookIngressTransport>
}

export interface ProviderPlatformRouteComposition {
  readonly observability: RunObservation
  readonly config: Parameters<typeof mountConfigRoutes>[1]
  readonly maintenance: Parameters<typeof mountMaintenanceRoutes>[1]
  readonly daemon: Parameters<typeof mountDaemonRoutes>[1]
  readonly plantuml: Parameters<typeof mountPlantumlRoutes>[1]
  readonly runtime: RuntimeModelQueries
  readonly runtimes: {
    readonly protocols: readonly RuntimeKind[]
    readonly profiles: RuntimeProfileCommands
    readonly queries: RuntimeProfileQueries
    readonly diagnostics: RuntimeDiagnosticCommands
  }
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
    /** RFC-370 §10 V17: the selected repository mirrors. */
    readonly mirrors: RepositoryMirrors
  }>
  readonly workflows: Readonly<{
    readonly runtime: Parameters<typeof mountWorkflowRoutes>[1]
    readonly module: Parameters<typeof mountWorkflowRoutes>[2]
  }>
  readonly workgroups: Parameters<typeof mountWorkgroupRoutes>[1]
  readonly resourcePackages: Parameters<typeof registerResourcePackageRoutes>[1]
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
  readonly webhookEndpoints: Parameters<typeof mountWebhookEndpointRoutes>[1]
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
  }>
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
  /** RFC-353 T9：技能来源追溯。归 knowledge-evolution，取数横跨 resource-catalog 与 memory。 */
  readonly skillProvenance: Parameters<typeof mountSkillProvenanceRoutes>[1]
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
  readonly configuration: ApplicationConfigurationQueries
  readonly authentication: HttpAuthenticationParticipant
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
  /** RFC-370 v2 H7: bootstrap-selected execution authority; absent means standalone. */
  readonly executionAuthority?: ExecutionAuthorityPort
}

export type SqliteAppCompositionInput = ProviderAppCompositionInput<'sqlite'>
export type PostgresqlAppCompositionInput = ProviderAppCompositionInput<'postgresql'>

/** Freeze one server-owned route assembly after its provider aggregates bind. */
function freezeComposedAppDeps<TCore extends AppHttpProviderCore>(
  input: ComposedAppDeps<TCore>,
): ComposedAppDeps<TCore> {
  return Object.freeze({
    token: input.token,
    configuration: input.configuration,
    authentication: input.authentication,
    core: Object.freeze({ ...input.core }),
    publicRoutes: Object.freeze({ ...input.publicRoutes }),
    apiRoutes: Object.freeze({ ...input.apiRoutes }),
    executionAuthority: input.executionAuthority,
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
    crewStationEvents: (app: Hono) => input.public.webhookIngress.crewStationEvents?.mount(app),
  } satisfies AppPublicRouteMounts)

  const apiRoutes = Object.freeze({
    config: (app: Hono) => mountConfigRoutes(app, input.platform.config),
    observability: (app: Hono) => input.platform.observability.mount(app),
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
    skillProvenance: (app: Hono) => mountSkillProvenanceRoutes(app, input.memory.skillProvenance),
    repos: (app: Hono) =>
      mountRepoRoutes(
        app,
        input.resourceCatalog.repositories.store,
        input.resourceCatalog.repositories.mirrors,
      ),
    cachedRepos: (app: Hono) =>
      mountCachedRepoRoutes(
        app,
        input.resourceCatalog.repositories.cached,
        input.resourceCatalog.repositories.store,
        input.resourceCatalog.repositories.mirrors,
      ),
    repoGroups: (app: Hono) =>
      mountRepoGroupRoutes(
        app,
        input.resourceCatalog.repositories.groups,
        input.resourceCatalog.repositories.store,
        input.resourceCatalog.repositories.mirrors,
      ),
    workflows: (app: Hono) =>
      mountWorkflowRoutes(
        app,
        input.resourceCatalog.workflows.runtime,
        input.resourceCatalog.workflows.module,
      ),
    workgroups: (app: Hono) => mountWorkgroupRoutes(app, input.resourceCatalog.workgroups),
    resourcePackages: (app: Hono) => {
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
    configuration: input.configuration,
    authentication: input.authentication,
    core: input.core,
    executionAuthority: input.executionAuthority,
    publicRoutes,
    apiRoutes,
  })
}

/** Named production entry points keep provider selection explicit at bootstrap. */
export interface ProviderAppOwnerInput<P extends DatabaseProvider> {
  readonly db: ProviderNeutralDatabase
  readonly token: string
  readonly appHome: string
  readonly secretBox: SecretBox
  readonly dbVersion: number
  readonly opencodeVersion: string | null
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly executionAuthority: ExecutionAuthorityPort
  readonly databaseTelemetry: () => DatabaseRuntimeTelemetry
  readonly maintenanceStatus?: () => MaintenanceStatus
  readonly daemonRuntime?: DaemonRuntimeQueries
  readonly daemonInfoPath: string
  readonly databaseMigration: DatabaseMigrationModule
  readonly portArtifacts: PortArtifactOperations
  readonly integrationIdentityAccess: IntegrationTriggerIdentityAccess
  readonly modules: Readonly<{
    core: SelectedDaemonProviderCore<P>
    repository: DaemonRepositoryCredentials
    resourceCatalog: DaemonResourceCatalogModules
    observation: DaemonObservationModules
    memory: DaemonMemoryModules
    taskExecution: DaemonTaskExecutionModules<P>
    scheduledTasks: DaemonScheduledTaskModules
    integration: DaemonIntegrationModules
    fusion: DaemonFusionModules
    digitalEmployee: DaemonDigitalEmployeeModules
    developmentAutomation: DaemonDevelopmentAutomationModules
    intent: DaemonIntentModules
  }>
  readonly selections?: Readonly<{
    resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
    resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
    resourcePackageSkillContent?: SkillPackageContentReader
    workspaceContent?: WorkspaceContentEffectsFactory
    runtimeInventoryContent?: TaskRuntimeInventoryContent
    repositoryRevisionContent?: ReturnType<typeof composeLocalRepositoryRevisionContent>
    codeReviewArtifacts?: ReturnType<typeof composeLocalCodeReviewArtifacts>
    repositoryRemote?: NonNullable<Parameters<typeof composeRepositoryMirrors>[0]['remote']>
  }>
  readonly testSeams?: Readonly<{
    workflowRuntime?: ProviderResourceCatalogRouteComposition['workflows']['runtime']
    codeHostRuntime?: ProviderSourceControlRouteComposition['codeHosts']['deps']
    buildScheduleLaunch?: BuildScheduleLaunch
  }>
}

/** Passive HTTP owners; the caller has already constructed all twelve session bundles. */
export function composeProviderAppComposition<P extends DatabaseProvider>(
  input: ProviderAppOwnerInput<P>,
): Readonly<{
  composition: ProviderAppCompositionInput<P>
  resourcePackageApplyActivity: ResourcePackageApplyActivityQuery
}> {
  const {
    core,
    repository,
    resourceCatalog: resourceCatalogModules,
    observation,
    memory,
    taskExecution: taskExecutionProvider,
    scheduledTasks,
    integration: integrationModules,
    fusion,
    digitalEmployee: digitalEmployeeModules,
    developmentAutomation,
    intent,
  } = input.modules
  const identityAccess = core.identityAccess
  const { applicationConfiguration, integrationIdentityAccess, portArtifacts } = input
  const configuration = applicationConfiguration.queries
  const { narrativeSystemAgentBinding, runtimeManagement, mcpRuntimeTests } = observation
  const {
    agentCatalog,
    skillCatalog,
    workflowCatalog,
    agentResourceIntegrity,
    mcpCatalog,
    mcpProbeStore,
    pluginCatalog,
    workgroupCatalog,
    digitalEmployeeAgentTemplates,
    capabilityTemplateOperations,
    capabilityTemplateAcl,
    developmentConfigOperations: developmentConfig,
    developmentAclRoutes,
  } = resourceCatalogModules
  const { repositoryTransport, codeHostConnections } = repository
  const { memoryOperations, memoryCatalog } = memory
  const boundCollaborationContext = taskExecutionProvider.collaboration
  const validationContext = taskExecutionProvider.validationContext
  const { scheduledTaskRuntime } = scheduledTasks
  const {
    webhookTerminalControl,
    webhookDispatcher,
    webhookDeliveryRuntime,
    webhookTriggerService,
    eventCenter,
  } = integrationModules
  const { fusionOperations } = fusion
  const digitalEmployee = digitalEmployeeModules.module
  const executionContracts = digitalEmployeeModules.executionContracts
  const developmentActivityOperations = digitalEmployeeModules.activityOperations
  const digitalEmployeePersistence = digitalEmployeeModules.routePersistence
  const developmentMissions = developmentAutomation.missionOperations
  const intentRoutes = intent.routes
  const resourcePackageBinding = composeResourcePackageBinding(input)
  const authorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
  const oidcIdentities = composeOidcIdentityOperations({
    db: input.db,
    identityAccess,
  })
  const oidcProviders = createOidcProvidersService({
    db: input.db,
    secretBox: input.secretBox,
  })
  const identityUserOperations = composeIdentityUserOperations({
    identityAccess,
    auth: core.authRuntime,
    afterDisabled: async () => await mcpRuntimeTests.reconcileDurableIntents(),
  })

  const codeHistoryQueries = composeCodeHistoryQueries(input.db)
  const codeWorkspace = composeLegacyCodeReadProviders(input.db).workspace
  const collaborationTaskAccess = createCollaborationTaskAccessPort(input.db)
  const taskRoutes = Object.freeze({
    configuration,
    operations: taskExecutionProvider.routes.tasks,
    workspaceQueries: composeTaskWorkspaceQueries({
      load: taskExecutionProvider.routes.tasks.get,
      contentScope: (workspaceRef) =>
        createWorkspaceContentScope(workspaceRef, input.selections?.workspaceContent),
    }),
    taskExecutionReadModels: taskExecutionProvider.readModels,
    runtimeInventoryContent: composeTaskRuntimeInventoryContent(
      input.selections?.runtimeInventoryContent,
    ),
    taskRecoveryOperations: taskExecutionProvider.recovery,
    codeWorkspace,
    // RFC-370 §10 V16: hosted reads answer from the task volume and persist as
    // object publications; standalone PostgreSQL keeps native worktrees and files.
    codeReview: Object.freeze({
      content:
        input.selections?.repositoryRevisionContent ?? composeLocalRepositoryRevisionContent(),
      artifacts: input.selections?.codeReviewArtifacts ?? composeLocalCodeReviewArtifacts(),
    }),
    repositoryWorkspace: core.repositoryWorkspaceStore,
    changeNarrative: Object.freeze({
      async requireMember(actor: Actor, taskId: string) {
        const access = await resolveCollaborationTaskAccess(boundCollaborationContext, {
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
      }) =>
        core.runtimeRegistry
          .resolveRuntimeByName(runtimeName ?? defaultRuntime)
          .then(narrativeSystemAgentBinding.bindRuntime),
      systemAgents: narrativeSystemAgentBinding.family,
    }),
  })
  const worktreeFiles = Object.freeze({
    store: core.repositoryWorkspaceStore,
    canViewTask: async (actor: Actor, task: { readonly id: string }) =>
      (await collaborationTaskAccess.resolveTask(actor, task.id)).visible,
    // RFC-370 §10 V15: the same content the task workspace queries read.
    content: (workspaceRef: string) =>
      input.selections?.workspaceContent?.bind(workspaceRef) ??
      createFileWorkspaceContentEffects(workspaceRef),
  })
  const collaborationRouteOperations = composeCollaborationRouteOperations({
    followupGenerator: composeClarifyFollowupGenerator({
      db: input.db,
      registry: core.runtimeRegistry,
      binding: narrativeSystemAgentBinding,
    }),
    db: input.db,
    context: boundCollaborationContext,
  })
  const workgroupTaskRoom = composeWorkgroupTaskRoom({
    db: input.db,
    taskParticipantFactory: taskExecutionProvider.workgroupTaskRoom,
    activeUsers: composeWorkgroupTaskRoomActiveUsers({
      userDirectory: identityAccess.userDirectory,
    }),
    dynamicWorkflow: composeWorkgroupTaskRoomDynamicWorkflow({
      validationContext,
      workflows: workflowCatalog.operations.create,
    }),
    systemUserId: SYSTEM_USER_ID,
    continuation: taskExecutionProvider.roomContinuation,
    broadcast(taskId, event) {
      taskBroadcaster.broadcast(TASK_CHANNEL(taskId), { id: -1, ...event })
    },
  })

  const integrationRoutes: ProviderAppCompositionInput<P>['integration'] = Object.freeze({
    scheduledTasks: Object.freeze({
      identityAccess: integrationIdentityAccess,
      scheduledTaskRuntime,
      buildScheduleLaunch:
        input.testSeams?.buildScheduleLaunch ?? taskExecutionProvider.trigger.buildScheduleLaunch,
      getDefaultRuntime: async () => (await configuration.read()).defaultRuntime ?? null,
    }),
    webhookEndpoints: Object.freeze({
      webhookEndpointService: integrationModules.webhookEndpointService,
    }),
    eventCenter,
    webhookTriggers: Object.freeze({
      deps: Object.freeze({ webhookTriggerService }),
      identityAccess: integrationIdentityAccess,
    }),
    webhookDeliveries: Object.freeze({
      webhookDeliveryRuntime,
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher,
      webhookTerminalControl,
    }),
  })

  const digitalDevelopmentRoutes: ProviderAppCompositionInput<P>['digitalDevelopment'] =
    Object.freeze({
      executionContracts,
      digitalEmployees: Object.freeze({
        persistence: digitalEmployeePersistence,
        module: digitalEmployee,
        activityOperations: developmentActivityOperations,
        contexts: identityAccess.directAuthority,
      }),
      developmentConfig: Object.freeze({
        aclRoutes: developmentAclRoutes,
        operations: developmentConfig,
        contexts: identityAccess.directAuthority,
      }),
      developmentMissions: Object.freeze({
        operations: developmentMissions,
        contexts: identityAccess.directAuthority,
      }),
      missionInputUploads: developmentAutomation.missionInputUploads,
    })

  const taskCatalog = composeTaskCatalog({
    sources: [...taskExecutionProvider.catalogSources, digitalEmployeeModules.taskCatalogSource],
  })
  const publicRoutes: ProviderAppCompositionInput<P>['public'] = Object.freeze({
    health: Object.freeze({
      deps: Object.freeze({
        opencodeVersion: input.opencodeVersion,
        dbVersion: input.dbVersion,
      }),
      identityAccess: identityAccess.diagnostics,
      database: core.healthDatabase,
    }),
    documentation: Object.freeze({ configuration }),
    webhookIngress: composeWebhookIngressTransport({
      crewStationEvents: integrationModules.crewStationEvents,
      webhookIngressPersistence: integrationModules.webhookIngressPersistence,
      secretBox: input.secretBox,
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher,
      webhookTerminalControl,
    }),
  })

  // One overview projection binds the session-owned domain queries.
  const overviewQuery: ProviderAppCompositionInput<P>['platform']['overview']['query'] =
    composeSystemOverviewQuery({
      resourceCatalog: composeResourceCatalogOverviewQuery(input.db),
      repositories: core.repositoryWorkspaceOperations.overviewQueries,
      integration: scheduledTaskRuntime.overview,
      memories: memoryCatalog,
      tasks: taskExecutionProvider.overview,
    })
  const platformRoutes: ProviderAppCompositionInput<P>['platform'] = Object.freeze({
    observability: composeRunObservation({
      db: input.db,
      tasks: createTaskObservationFacts(input.db),
      runtimes: runtimeManagement.observations,
    }),
    config: Object.freeze({
      configuration: applicationConfiguration.composeCommands({
        runtimeRegistry:
          runtimeManagement.configuration satisfies RuntimeProfileConfigurationCommands,
        withRuntimeProbeConfigFence: composeRuntimeProbeConfigFence(
          applicationConfiguration.notificationKey,
        ),
        runtimeTests: mcpRuntimeTests.reconciliation,
        concurrencyHotApply: composeConfigConcurrencyHotApply(
          taskExecutionProvider.processConcurrencyScope,
        ),
      }),
    }),
    maintenance: Object.freeze({
      configuration,
      maintenanceStatus: input.maintenanceStatus,
      databaseTelemetry: input.databaseTelemetry,
    }),
    daemon: Object.freeze({
      runtime: selectDaemonRuntimeQueries(input.daemonRuntime, { infoPath: input.daemonInfoPath }),
    }),
    plantuml: Object.freeze({ configuration }),
    runtime: runtimeManagement.models,
    runtimes: runtimeManagement.runtimes,
    overview: Object.freeze({
      authorization: Object.freeze({ directAuthority: identityAccess.directAuthority }),
      query: overviewQuery,
    }),
  })

  const resourceCatalogRoutes: ProviderAppCompositionInput<P>['resourceCatalog'] = Object.freeze({
    agents: Object.freeze({
      ...agentCatalog,
      authorityFor,
      listDigitalEmployeeTemplates: () =>
        listDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates),
      taskLaunch: taskExecutionProvider.routeLaunch.agent,
    }),
    mcps: Object.freeze({
      queries: mcpCatalog.queries,
      operations: mcpCatalog.operations,
      aclIdentity: mcpCatalog.participants.aclIdentity,
      probeStore: mcpProbeStore,
      authorityFor,
      runtimeTests: { commands: mcpRuntimeTests.commands, queries: mcpRuntimeTests.queries },
      runtimeTestCommandContextFor: mcpRuntimeTests.contexts.command,
      runtimeTestQueryContextFor: mcpRuntimeTests.contexts.query,
      probeRunner: mcpRuntimeTests.probeRunner,
    }),
    plugins: Object.freeze({
      queries: pluginCatalog.queries,
      operations: pluginCatalog.operations,
      authorityFor,
    }),
    skills: Object.freeze({ ...skillCatalog, authorityFor }),
    repositories: Object.freeze({
      store: core.repositoryWorkspaceStore,
      cached: Object.freeze({
        configuration,
        appHome: input.appHome,
        secretBox: input.secretBox,
      }),
      groups: Object.freeze({ configuration }),
      mirrors: composeRepositoryMirrors({
        store: core.repositoryWorkspaceStore,
        secretBox: input.secretBox,
        appHome: input.appHome,
        ...(input.selections?.repositoryRemote === undefined
          ? {}
          : { remote: input.selections?.repositoryRemote }),
      }),
    }),
    workflows: Object.freeze({
      runtime: input.testSeams?.workflowRuntime ?? Object.freeze({}),
      module: Object.freeze({ ...workflowCatalog, authorityFor }),
    }),
    workgroups: Object.freeze({
      queries: workgroupCatalog.queries,
      operations: workgroupCatalog.operations,
      resourceIntegrityQueries: agentResourceIntegrity.queries,
      authorityFor,
      taskLaunch: taskExecutionProvider.routeLaunch.workgroup,
    }),
    resourcePackages: Object.freeze({
      catalog: resourcePackageBinding.catalog,
      commandContextFor: resourcePackageBinding.commandContextFor,
      queryContextFor(actor: Actor) {
        return identityAccess.contexts.queryFromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actor),
          'http',
        )
      },
    }),
    workgroupTasks: Object.freeze({ module: workgroupTaskRoom, authorityFor }),
  })

  const taskExecutionRoutes: ProviderAppCompositionInput<P>['taskExecution'] = Object.freeze({
    tasks: taskRoutes,
    catalog: taskCatalog,
    archive: Object.freeze({
      configuration,
      taskArchiveMaintenance: taskExecutionProvider.archive,
    }),
    portArtifacts: Object.freeze({
      taskExecutionReadModels: taskExecutionProvider.readModels,
      portArtifacts,
    }),
    clarifyDirective: Object.freeze({
      operations: taskExecutionProvider.routes.clarifyDirective,
    }),
    feedback: Object.freeze({
      collaborationContext: boundCollaborationContext,
      memoryOperations,
    }),
  })

  const sourceControlRoutes: ProviderAppCompositionInput<P>['sourceControl'] = Object.freeze({
    codeHosts: Object.freeze({
      deps: input.testSeams?.codeHostRuntime ?? Object.freeze({}),
      service: codeHostConnections,
    }),
    repositoryTransportCredentials: Object.freeze({
      runtime: input.testSeams?.codeHostRuntime ?? Object.freeze({}),
      route: Object.freeze({
        credentials: repositoryTransport.ownCredentials,
        currentSubjects: identityAccess.resolveAuthority,
      }),
    }),
    worktreeFiles,
  })

  const codeRoutes: ProviderAppCompositionInput<P>['code'] = Object.freeze({
    history: codeHistoryQueries,
    capabilityTemplates: Object.freeze({
      codeHistoryQueries,
      capabilityTemplates: capabilityTemplateOperations,
      capabilityTemplateAcl,
    }),
  })

  const collaborationRoutes: ProviderAppCompositionInput<P>['collaboration'] = Object.freeze({
    operations: collaborationRouteOperations,
    appHome: input.appHome,
  })

  const memoryRoutes: ProviderAppCompositionInput<P>['memory'] = Object.freeze({
    fusion: Object.freeze({
      operations: fusionOperations,
      directAuthority: identityAccess.directAuthority,
    }),
    // RFC-353 T9：技能来源追溯——版本流水来自 resource-catalog，融合记录来自 memory，
    // 拼装归 knowledge-evolution，所以路由挂在 KE 的 inbound 上。
    skillProvenance: Object.freeze({
      skills: skillCatalog.queries,
      versions: skillCatalog.versionQueries,
      authorityFor: (actor: Actor) =>
        directOperationAuthority(identityAccess.directAuthority, actor),
      memoryAuthorityFor: (actor: Actor) => ({
        actor,
        authority: directRequestAuthority(identityAccess.directAuthority, actor),
      }),
      listFusedInto: (skillId: string) => memoryCatalog.queries.listFusedInto(skillId),
      filterVisibleMemories: (
        authority: Parameters<
          ProviderMemoryRouteComposition['skillProvenance']['filterVisibleMemories']
        >[0],
        rows: Parameters<
          ProviderMemoryRouteComposition['skillProvenance']['filterVisibleMemories']
        >[1],
      ) => memoryCatalog.queries.filterVisible(authority, rows),
    }),
    memories: Object.freeze({
      catalog: memoryCatalog,
      identityAccess: Object.freeze({
        contexts: identityAccess.contexts,
        directAuthority: identityAccess.directAuthority,
      }),
    }),
    distillJobs: Object.freeze({
      memoryDistillCommands: memoryOperations.distillCommands,
      memoryDistillQueries: memoryOperations.distillQueries,
    }),
  })

  const identityRoutes: ProviderAppCompositionInput<P>['identity'] = Object.freeze({
    auth: Object.freeze({
      deps: Object.freeze({ configuration }),
      identityAccess,
      bindings: Object.freeze({
        auth: core.authRuntime,
        listIdentitiesForUser: (userId: string) => oidcIdentities.listIdentitiesForUser(userId),
        listTokenAuditForUser: (userId: string) => core.tokenCallAudit.listForUser(userId),
      }),
    }),
    oidcAuth: Object.freeze({
      deps: Object.freeze({ configuration }),
      bindings: Object.freeze({
        auth: core.authRuntime,
        providers: oidcProviders,
        identities: oidcIdentities,
      }),
    }),
    oidc: Object.freeze({ auth: core.authRuntime, providers: oidcProviders }),
    users: Object.freeze({
      auth: Object.freeze({
        auth: core.authRuntime,
        listTokenAudit: () => core.tokenCallAudit.list(),
      }),
      identityAccess: Object.freeze({
        contexts: identityAccess.contexts,
        directAuthority: identityAccess.directAuthority,
        operations: identityUserOperations,
      }),
    }),
  })

  const systemRoutes: ProviderAppCompositionInput<P>['system'] = Object.freeze({
    maintenanceDisk: core.maintenanceDisk,
    backup: Object.freeze({ operations: core.systemOperations, identityAccess }),
    restore: Object.freeze({ operations: core.systemOperations, identityAccess }),
    databaseMigration: Object.freeze({
      operations: input.databaseMigration.operations,
      identityAccess,
    }),
  })

  const composition: ProviderAppCompositionInput<P> = Object.freeze({
    token: input.token,
    configuration,
    authentication: core.httpAuthentication,
    core,
    public: publicRoutes,
    platform: platformRoutes,
    resourceCatalog: resourceCatalogRoutes,
    taskExecution: taskExecutionRoutes,
    integration: integrationRoutes,
    sourceControl: sourceControlRoutes,
    code: codeRoutes,
    digitalDevelopment: digitalDevelopmentRoutes,
    collaboration: collaborationRoutes,
    memory: memoryRoutes,
    intent: intentRoutes,
    identity: identityRoutes,
    system: systemRoutes,
    executionAuthority: input.executionAuthority,
  })
  return Object.freeze({
    composition,
    resourcePackageApplyActivity: resourcePackageBinding.applyActivity,
  })
}

/** Resource-package authority, catalog and atomic apply share one session binding. */
function composeResourcePackageBinding<P extends DatabaseProvider>(
  input: ProviderAppOwnerInput<P>,
) {
  const packageActorsByAuthority = new WeakMap<object, Actor>()
  const box = input.secretBox
  const identityAccess = input.modules.core.identityAccess
  const resourceCatalogModules = input.modules.resourceCatalog
  const provider = composePostgresqlResourcePackageProvider({
    db: input.db,
    appHome: input.appHome,
    authorityResolver: {
      resolve(authority) {
        const actor = packageActorsByAuthority.get(authority)
        if (actor === undefined) throw new Error('foreign-resource-package-authority')
        return actor
      },
    },
    mcpLifecycle: resourceCatalogModules.mcpTransactionLifecycle,
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({
      db: input.db,
    }),
    skillArtifacts: input.selections?.resourcePackageSkillArtifacts,
    skillPackageContent: input.selections?.resourcePackageSkillContent,
    ...(input.selections?.resourcePackagePluginArtifacts === undefined
      ? { pluginInstaller: createResourcePackagePluginInstaller() }
      : { pluginArtifacts: input.selections?.resourcePackagePluginArtifacts }),
  })
  const atomicApply = createPostgresqlResourcePackageAtomicApplyOperations({
    db: input.db,
    box,
  })
  return Object.freeze({
    applyActivity: atomicApply,
    catalog: composePostgresqlResourcePackageCatalog({
      provider,
      execution: createPostgresqlResourcePackageExecutionAdapter({
        box,
        provider,
        atomicApply,
      }),
    }),
    commandContextFor(actor: Actor): CommandContext {
      const context = identityAccess.contexts.fromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      packageActorsByAuthority.set(context.authority, actor)
      return context
    },
  })
}

function composeConfigConcurrencyHotApply(daemonScope: object): ConfigConcurrencyHotApplyCommand {
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

/** Owned finite resource initialization and runtime-test composition for one application. */
export interface UnstartedApplicationScope {
  readonly trackReady: <T>(ready: Promise<T>) => Promise<T>
  readonly createMcpRuntimeTests: (deps: McpDiagnosticsCompositionInput) => McpDiagnosticsRuntime
}

export function composeSqliteAppDeps(
  deps: AppDeps & { readonly providerCore: SelectedDaemonProviderCore<'sqlite'> },
): SqliteAppComposition<SelectedDaemonProviderCore<'sqlite'>>
export function composeSqliteAppDeps(deps: AppDeps): SqliteAppComposition
export function composeSqliteAppDeps(deps: AppDeps): SqliteAppComposition {
  return composeSqliteApplicationDeps(deps)
}

export function composeSqliteApplicationDeps(
  deps: AppDeps,
  unstarted?: UnstartedApplicationScope,
): SqliteAppComposition {
  if (deps.intentModules !== undefined && deps.intentTestDependencies !== undefined) {
    throw new Error('intent-modules-and-test-dependencies-conflict')
  }
  const appHome = deps.appHome ?? Paths.root
  const workspaceUploads = selectWorkspaceUploadContentFactory(deps.workspaceUploads)
  const isolationWorkspaces = selectIsolationWorkspaceFactory(deps.isolationWorkspaces)
  const repositoryGitWorkspaces = selectRepositoryGitWorkspaceFactory(deps.repositoryGitWorkspaces)
  const workspaceReads = selectRepositoryWorkspaceReadQueries(deps.workspaceReads)
  const developmentPurposeRoot =
    deps.developmentPurposeRoot ??
    composeDevelopmentPurposeRoot({
      appHome,
      selection: deps.developmentPurposes,
      evidenceArtifacts: deps.evidenceArtifacts,
      evidenceDocumentCommands: deps.evidenceDocumentCommands,
    })
  const selectedTaskRuns = selectTaskRunRootSelection(deps.taskRunSelection)
  const workspaceExcludeProfilesFor = composeTaskWorkspaceExcludeProfilesFor(
    deps.workspaceExcludeProfiles,
  )
  const nodeRunPrompts =
    selectedTaskRuns === undefined
      ? deps.nodeRunPrompts === undefined
        ? composeNodeRunPromptOperations(deps.nodeRunPromptContentEffects, join(appHome, 'runs'))
        : selectNodeRunPromptOperations(deps.nodeRunPrompts)
      : selectedTaskRuns.nodeRunPrompts
  const portArtifacts =
    selectedTaskRuns === undefined
      ? deps.portArtifacts === undefined
        ? composePortArtifactOperations(deps.portArtifactContentEffects, appHome)
        : selectPortArtifactOperations(deps.portArtifacts, appHome)
      : selectedTaskRuns.portArtifacts
  const taskRunRoot =
    selectedTaskRuns === undefined
      ? composeLocalTaskRunRootSelection({ nodeRunPrompts, portArtifacts })
      : selectedTaskRuns
  const applicationConfiguration =
    deps.applicationConfiguration ??
    composeApplicationConfigurationBinding({
      kind: 'file',
      configPath: deps.configPath,
      ...(deps.configuration === undefined ? {} : { queries: deps.configuration }),
    })
  const configuration = applicationConfiguration.queries
  const taskLaunchConfiguration = composeTaskLaunchConfiguration(
    deps.applicationConfiguration !== undefined ||
      applicationConfiguration.synchronousQueries === undefined
      ? { kind: 'selected', queries: configuration }
      : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
  )
  const selectedCore: DaemonProviderCore =
    deps.providerCore ??
    composeDaemonProviderCore({
      db: deps.db,
      appHome,
      secretBox: deps.secretBox,
      daemonToken: deps.token,
      adapters: DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({
        db: deps.db,
        appHome,
        secretBox: deps.secretBox,
      }),
      realtimePolicy: composeDaemonRealtimePolicy({
        resourceVisibility: {
          canViewResource: (actor, type, row) =>
            resourceCatalogModules.resourceCatalog.authorization.canViewResource(actor, type, row),
        },
        memoryVisibility: {
          canViewMemory: (authority, actor, scope) =>
            memoryCatalog.queries.canView({ authority, actor }, scope),
        },
        repoImportOwnerUserId: batchOwnerUserId,
        redactTaskEventPayload: redactEventPayload,
      }),
      onCredentialRevoked: triggerRevalidation,
      identityEvents: { authorityRevisionChanged() {} },
      presenceProjection: { publish() {} },
    })
  const providerCore = Object.freeze({
    ...selectedCore,
    identityAccess: deps.identityAccess ?? selectedCore.identityAccess,
    systemOperations: deps.systemOperations ?? selectedCore.systemOperations,
  })
  const scheduledTaskModules: DaemonScheduledTaskModules =
    deps.scheduledTaskModules ??
    composeDaemonScheduledTaskModules({
      db: deps.db,
      assertAgentIntegrity: (agentIds) =>
        agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
    })
  const baseIdentityAccess = providerCore.identityAccess
  const runtimeRegistry = providerCore.runtimeRegistry
  const standalone = standaloneModuleAdapters()
  const observationModules: DaemonObservationModules =
    deps.observationModules ??
    composeDaemonObservationModules({
      db: deps.db,
      appHome,
      configuration,
      notificationKey: applicationConfiguration.notificationKey,
      identityAccess: baseIdentityAccess,
      daemonActor: providerCore.daemonActor,
      runtimeRegistry,
      mcpCatalog: () => mcpCatalog,
      adapters: {
        ...standalone,
        mcpDiagnostics: unstarted?.createMcpRuntimeTests ?? standalone.mcpDiagnostics,
        runtimeManagement: deps.runtimeManagement ?? standalone.runtimeManagement,
        workspacePresence: () => deps.workspacePresence ?? standalone.workspacePresence(),
      },
      mcpRuntimeTestDependencies: deps.mcpRuntimeTestDependencies,
      runtimeDiagnosticTestDependencies: deps.runtimeDiagnosticTestDependencies,
    })
  const { mcpRuntimeTests: userRuntimeTests } = observationModules
  const resourceCatalogModules: DaemonResourceCatalogModules =
    deps.resourceCatalogModules ??
    composeDaemonResourceCatalogModules({
      db: deps.db,
      skillContentRoot: Paths.root,
      skillContent: deps.skillContent,
      pluginInstaller: deps.pluginInstaller,
      runtimeProfiles: { get: (name) => runtimeRegistry.getRuntime(name) },
      mcpRuntime: {
        prepareDelete: (id) => userRuntimeTests.prepareMcpDelete(id),
        reconcileDurableIntents: () => userRuntimeTests.reconcileDurableIntents(),
      },
    })
  const { agentResourceIntegrity, mcpCatalog } = resourceCatalogModules
  const repositoryBootstrap =
    deps.repositoryCredentials ??
    composeDaemonRepositoryCredentials({
      db: deps.db,
      appHome,
      secretBox: deps.secretBox,
      developmentPurposeRoot,
      repositoryWorkspaceStore: providerCore.repositoryWorkspaceStore,
      repositoryWorkspaceOperations: providerCore.repositoryWorkspaceOperations,
      repositoryTransportCredentialRepository: providerCore.repositoryTransportCredentialRepository,
      repositoryTransport: deps.repositoryTransport,
      codeHostFetch: deps.codeHostFetch,
    })
  const memoryModules: DaemonMemoryModules =
    deps.memoryModules ??
    composeDaemonMemoryModules({
      db: deps.db,
      nodeRunPrompts,
      systemAgentBinding: observationModules.memorySystemAgentBinding,
      contexts: baseIdentityAccess.contexts,
      reviewedArtifacts: {
        read: async (finalPath) =>
          await readCommittedReviewArtifactBody(collaborationContext, finalPath),
      },
    })
  const { memoryCatalog } = memoryModules
  const taskExecutionModules: DaemonTaskExecutionModules<'sqlite'> =
    deps.taskExecutionModules ??
    composeDaemonTaskExecutionModules({
      db: deps.db,
      appHome,
      configPath: deps.configPath,
      secretBox: deps.secretBox,
      taskLaunchConfiguration,
      adapters: DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({ db: deps.db }),
      core: {
        ...providerCore,
        identityAccess: baseIdentityAccess,
        runtimeRegistry,
        repositoryWorkspaceStore: repositoryBootstrap.repositoryWorkspaceStore,
      },
      observation: observationModules,
      resources: { ...resourceCatalogModules, owners: composeOwnerIdentityQueries(deps.db) },
      repository: repositoryBootstrap,
      memory: memoryModules,
      selection: {
        taskRunBinding: taskRunRoot.drive,
        workspaceExcludeProfilesFor,
        nodeRunPrompts,
        portArtifacts,
        isolationWorkspaces,
        repositoryGitWorkspaces,
        workspaceReads,
        archive: deps.taskArchive,
        effects: deps.taskDeletionEffects,
        archivedEvents: deps.archivedNodeEvents,
        reviewArtifacts: deps.reviewArtifacts,
        reviewRollbackSnapshots: deps.reviewRollbackSnapshots,
        workspaceUploads,
        preparationEffects: deps.repositoryPreparationEffects,
        scratchEffects: deps.scratchWorkspaceEffects,
        fusionWorkspaces: createFileFusionWorkspaceEffects({ appHome }),
      },
      finalizeWorkspace: async (taskId) => {
        await finishClaimedWebhookWorkspacePrune(deps.db, taskId)
      },
    })
  const taskExecutionPersistence = taskExecutionModules.persistence
  const collaborationContext = taskExecutionModules.collaboration
  const identityAccess = withIntegrationTriggerResources(
    baseIdentityAccess,
    scheduledTaskModules.scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionModules.resources,
  )
  const fusionModules: DaemonFusionModules =
    deps.fusionModules ??
    composeDaemonFusionModules({
      db: deps.db,
      appHome,
      memories: memoryCatalog,
      skillContent: deps.skillContent,
      tasks: taskExecutionModules.fusion,
    })
  const integrationModules: DaemonIntegrationModules =
    deps.integrationModules ??
    composeDaemonIntegrationModules({
      db: deps.db,
      secretBox: deps.secretBox,
      configuration,
      scheduledTaskRuntime: scheduledTaskModules.scheduledTaskRuntime,
      identityAccess,
      bindEventAutomationContexts: createEventAutomationDelegatedContextBinding,
      runtimeRegistry: taskExecutionModules.executionModule.runtimeRegistry,
      workspaceMaintenance: composeWorkspaceMaintenanceCommand({
        db: deps.db,
        appHome,
        terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
        isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
        invalidateWorkspacePath: invalidateCallGraphIndex,
      }),
      taskExecutions: taskExecutionModules.trigger.taskExecutions,
      digitalEmployeeWorkStart: {
        launch: (request) => digitalEmployeeModules.workStart.launch(request),
      },
      developmentDeliveryProvider: repositoryBootstrap.developmentDeliveryProvider,
      developmentPurposeRoot,
      adapters: {
        customObserverPrograms: deps.customObserverPrograms,
        webhookDispatcher: deps.webhookDispatcher,
        webhookTerminalControl: deps.webhookTerminalControl,
      },
    })
  if (deps.integrationModules === undefined) {
    void unstarted?.trackReady(integrationModules.eventCenter.initialize())
  }
  const developmentWorkspaceEffects = selectDevelopmentWorkspaceEffectBinding({
    actionWorkspaceEffects: deps.actionWorkspaceEffects,
    automationWorkspaceEffects: deps.automationWorkspaceEffects,
    conflictWorkspaceSelected: deps.conflictMergeWorkspaceEffects !== undefined,
  })
  const digitalEmployeeModules: DaemonDigitalEmployeeModules =
    deps.digitalEmployeeModules ??
    composeDaemonDigitalEmployeeModules({
      db: deps.db,
      appHome,
      configuration,
      log: createLogger('digital-employee'),
      typePackageDriftPolicy: deps.digitalEmployeeTypePackageDriftPolicy,
      core: {
        daemonActor: providerCore.daemonActor,
        userDirectory: identityAccess.userDirectory,
        directAuthority: identityAccess.directAuthority,
      },
      resources: resourceCatalogModules,
      repository: repositoryBootstrap,
      integration: integrationModules,
      taskExecution: taskExecutionModules,
      developmentPurposeRoot,
      workspaceEffects: developmentWorkspaceEffects,
      repositoryBaselines: deps.repositoryBaselines,
      evidenceArtifacts: deps.evidenceArtifacts,
      repositoryCandidateEffects: deps.repositoryCandidateEffects,
      conflictMergeWorkspaceEffects: deps.conflictMergeWorkspaceEffects,
      adapters: {
        employeePrograms: deps.employeePrograms,
        employeeInputArtifacts: deps.employeeInputArtifacts,
        employeeCaseWorkspaceEffects: deps.employeeCaseWorkspaceEffects,
        platformTools: deps.digitalEmployeePlatformTools,
        executionContracts: deps.executionContracts,
      },
    })
  const developmentAutomationModules: DaemonDevelopmentAutomationModules =
    deps.developmentAutomationModules ??
    composeDaemonDevelopmentAutomationModules({
      db: deps.db,
      appHome,
      log: createLogger('development-automation'),
      developmentPurposeRoot,
      workspaceEffects: developmentWorkspaceEffects,
      repository: repositoryBootstrap,
      integration: integrationModules,
      hostTasks: taskExecutionModules.hostTasks,
      writerCutover: digitalEmployeeModules.writerCutover,
      verificationCommands: deps.verificationCommands,
      repositoryBaselines: deps.repositoryBaselines,
      evidenceRead: deps.evidenceRead,
      attemptContext: deps.attemptContext,
      repositoryCandidateEffects: deps.repositoryCandidateEffects,
      conflictMergeWorkspaceEffects: deps.conflictMergeWorkspaceEffects,
      missionInputBlobs: deps.missionInputBlobs,
      evidenceArtifacts: deps.evidenceArtifacts,
    })
  const intentModules =
    deps.intentModules ??
    composeDaemonIntentModules({
      db: deps.db,
      appHome,
      configuration,
      log: createLogger('intent'),
      core: identityAccess,
      resources: resourceCatalogModules,
      observation: observationModules,
      digitalEmployee: digitalEmployeeModules,
      adapters: {
        intentArtifacts: deps.intentArtifacts,
        httpTurnFixture: deps.intentTestDependencies?.runFn,
      },
    })
  const unexpectedMigrationAdmission = async (): Promise<never> => {
    throw new Error('direct HTTP composition does not implement daemon migration admission')
  }
  const http = composeProviderAppComposition({
    db: deps.db,
    token: deps.token,
    appHome,
    secretBox: deps.secretBox,
    dbVersion: deps.dbVersion,
    opencodeVersion: deps.opencodeVersion,
    applicationConfiguration,
    executionAuthority: deps.executionAuthority ?? composeLocalExecutionAuthority(),
    databaseTelemetry:
      deps.databaseTelemetry ?? (() => ({ version: 1, provider: 'sqlite', poolWait: null })),
    maintenanceStatus: deps.maintenanceStatus,
    daemonRuntime: deps.daemonRuntime,
    daemonInfoPath: deps.daemonInfoPath ?? Paths.daemonInfo,
    databaseMigration:
      deps.databaseMigration ??
      composeDatabaseMigrationModule({
        admission: {
          freezeAndDrain: unexpectedMigrationAdmission,
          reopenSqlite: unexpectedMigrationAdmission,
          activatePostgresql: unexpectedMigrationAdmission,
          openPostgresqlAdmission: unexpectedMigrationAdmission,
        },
        sqlitePath: join(appHome, 'workflow.db'),
        operationsRoot: join(appHome, 'database-migrations'),
        generationPointerPath: join(appHome, 'database-generation.json'),
        configPath: deps.configPath,
        executionMode: 'inline',
      }),
    portArtifacts,
    integrationIdentityAccess: identityAccess,
    modules: {
      core: providerCore,
      repository: repositoryBootstrap,
      resourceCatalog: resourceCatalogModules,
      observation: observationModules,
      memory: memoryModules,
      taskExecution: taskExecutionModules,
      scheduledTasks: scheduledTaskModules,
      integration: integrationModules,
      fusion: fusionModules,
      digitalEmployee: digitalEmployeeModules,
      developmentAutomation: developmentAutomationModules,
      intent: intentModules,
    },
    selections: {
      resourcePackageSkillArtifacts: deps.resourcePackageSkillArtifacts,
      resourcePackagePluginArtifacts: deps.resourcePackagePluginArtifacts,
      resourcePackageSkillContent: deps.resourcePackageSkillContent,
      workspaceContent: deps.workspaceContent,
      runtimeInventoryContent: deps.runtimeInventoryContent,
    },
    testSeams: {
      workflowRuntime: { workflowExactOperationHook: deps.workflowExactOperationHook },
      codeHostRuntime: { codeHostFetch: deps.codeHostFetch },
      buildScheduleLaunch: deps.buildScheduleLaunch,
    },
  })
  const application = composeProviderAppDeps(http.composition)
  return Object.freeze({
    ...application,
    intentModules,
    digitalEmployeeModules,
    developmentAutomationModules,
    taskExecutionModules,
    digitalEmployeeWorkStart: digitalEmployeeModules.workStart,
    repositoryWorkspaceStore: repositoryBootstrap.repositoryWorkspaceStore,
    taskExecutionReadModels: taskExecutionModules.readModels,
    collaborationContext,
    resourcePackageApplyActivity: http.resourcePackageApplyActivity,
  })
}

/**
 * Every `/api/*` route in its canonical order.  Provider composition supplies
 * closed bindings, but cannot add, remove or reorder route domains.
 */
export function mountApiRoutes(app: Hono, deps: ComposedAppDeps): void {
  const authority = deps.executionAuthority
  if (authority !== undefined) bindExecutionAvailability(app, () => executionStatusOf(authority))
  const routes = deps.apiRoutes
  routes.observability(app)
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
  // `taskArchive` 必须挂在 `tasks` **之前**，这不是审美问题：`routes/tasks.ts` 给任务子资源装了
  // 一道可见性中间件 `'/api/tasks/:id/*'`，而 **Hono 的 `*` 能匹配零个段**——它会命中兄弟字面
  // 路由 `POST /api/tasks/archive` 并把 `id` 解成 `'archive'`，然后去查一个叫 archive 的任务、
  // 查不到就 404，路由自己的 `settings:write` 门永远轮不到执行。而 Hono 的中间件与处理器按注册
  // 顺序组链，先注册的终结处理器会在中间件之前收口：archive 先挂，中间件对它一次都不跑，对
  // `/api/tasks/:id` 与 `/api/tasks/:id/...` 则照旧生效。
  //
  // 症状只在**非管理员**身上出现（`assertTaskVisibleProjection` 第一句对 `tasks:read:all` 短路），
  // 所以管理员一路 200、e2e 的 OPS-038 却连红十三晚（Expected 403 / Received 404）。判据在
  // `tests/rfc311-task-archive-route-reachability.test.ts`——它钉的是结果（非管理员打到的是自己的
  // 权限门，不是 404），次序写错就红。**再往 `/api/tasks/` 下加字面路由时，一律挂在 tasks 之前。**
  routes.taskArchive(app)
  routes.tasks(app)
  routes.taskCatalog(app)
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
  routes.databaseMigration(app)
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

/** Shared request transport; callers supply already-composed route bindings. */
export interface HttpRequestAppDeps {
  readonly authentication: HttpAuthenticationParticipant
  readonly core: ComposedAppDeps['core']
  readonly publicRoutes: ComposedAppDeps['publicRoutes']
  readonly mountApi: AppRouteMount
  /** RFC-370 M0 — states the deployment to the embedded SPA; standalone by default. */
  readonly deploymentMode?: FrontendDeploymentMode
}

export function createHttpRequestApp(deps: HttpRequestAppDeps): Hono {
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
  deps.publicRoutes.crewStationEvents?.(app)

  app.use('/api/*', composeHttpAuthenticationMiddleware(deps.authentication))
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

  deps.mountApi(app)
  app.onError(errorHandler)

  if (IS_EMBEDDED) {
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
        return c.json(
          { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
          404,
        )
      }
      const response = await getEmbeddedFrontendResponse(
        c.req.path,
        undefined,
        deps.deploymentMode ?? 'standalone',
      )
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

/** Build the HTTP/MCP application from already-selected provider ports. */
export function createComposedApp(deps: ComposedAppDeps): Hono {
  return createHttpRequestApp({
    authentication: deps.authentication,
    core: deps.core,
    publicRoutes: deps.publicRoutes,
    deploymentMode: deps.executionAuthority?.mode ?? 'standalone',
    mountApi(app) {
      mountApiRoutes(app, deps)
      mountMcpTransport(app, {
        tokenCallAudit: deps.core.tokenCallAudit,
        configuration: deps.configuration,
        operationInvokerFor: (actor) =>
          createBoundOperationInvoker(
            app,
            directMcpOperationAuthority(deps.core.identityAccess.directAuthority, actor),
          ),
      })

      assertRouteMetaCoverage(
        app.routes.map((route) => ({ method: route.method, path: route.path })),
      )
      assertOperationCatalogClosed()
    },
  })
}

export function createApp(deps: AppDeps): Hono
export function createApp(deps: ComposedAppDeps): Hono
export function createApp(deps: AppDeps | ComposedAppDeps): Hono {
  return createComposedApp('apiRoutes' in deps ? deps : composeSqliteAppDeps(deps))
}

export interface RequirementPurposeSelection extends RequirementAdapterBinding {
  readonly staging: EvidenceStagingFactory
  readonly documentCommands: EvidenceDocumentCommands
}
export interface PipelinePurposeSelection extends PipelineAdapterBinding {
  readonly staging: PipelineStagingFactories
}
export interface DevelopmentPurposeSelection {
  readonly requirement?: RequirementPurposeSelection
  readonly pipeline?: PipelinePurposeSelection
  readonly approval?: ApprovalAdapterBinding
}
export interface SelectedDevelopmentPurposeRoot {
  readonly requirement: RequirementPurposeSelection
  readonly pipeline: PipelinePurposeSelection
  readonly approval: ApprovalAdapterBinding
  readonly evidenceArtifacts: EvidenceArtifactPort
}

function assertPurposePair(
  selection: RequirementPurposeSelection | PipelinePurposeSelection | ApprovalAdapterBinding,
  names: readonly string[],
  factories: readonly EvidenceStagingFactory[],
): void {
  if (typeof selection?.configurationFor !== 'function') {
    throw new Error('development-purpose-configuration-binding-incomplete')
  }
  const effects = selection.effects
  if (
    typeof effects?.programs?.bind !== 'function' ||
    effects.namespace?.kind !== 'evidence-staging-namespace'
  ) {
    throw new Error('development-purpose-program-binding-incomplete')
  }
  const members = effects as unknown as Record<string, unknown>
  for (const name of names) {
    if (typeof members[name] !== 'function') {
      throw new Error(`development-purpose-effects-incomplete:${name}`)
    }
  }
  for (const factory of factories) {
    assertEvidenceStagingFactory(factory)
    if (factory.namespace.reference !== effects.namespace?.reference) {
      throw new Error('development-purpose-staging-namespace-mismatch')
    }
  }
}

/** Bootstrap selects each whole purpose pair once and forwards it to every subcomposition. */
export function composeDevelopmentPurposeRoot(input: {
  readonly appHome: string
  readonly selection?: DevelopmentPurposeSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
}): SelectedDevelopmentPurposeRoot {
  let evidence = input.evidenceArtifacts
  const artifacts = (): EvidenceArtifactPort =>
    (evidence ??= createLocalEvidenceArtifactPort(input.appHome))
  const content = createLocalEvidenceStagingNamespace(artifacts)
  const native = createLocalDevelopmentAdapterEffects({
    namespace: content.namespace,
    resolveStaging: (reference) => content.resolve(reference),
  })
  const nativeBinding = (mockKey: string) => {
    const secretSource = Object.freeze({ ...process.env })
    const mockUrl = process.env[mockKey]
    return {
      configurationFor(content: Parameters<RequirementAdapterBinding['configurationFor']>[0]) {
        return native.configurationFor({
          adapterContent: content,
          secretSource,
          ...(mockUrl === undefined ? {} : { extraEnv: { [mockKey]: mockUrl } }),
        })
      },
    }
  }
  const requirement = input.selection?.requirement ?? {
    ...nativeBinding('AW_REQUIREMENT_MOCK_URL'),
    effects: native.requirement,
    staging: createLocalEvidenceStagingFactory(content, {
      kind: 'requirement',
      root: join(input.appHome, 'evidence', 'staging'),
    }),
    get documentCommands() {
      return (
        input.evidenceDocumentCommands ??
        createFileEvidenceDocumentCommands({
          evidence: artifacts(),
          stagingRoot: join(input.appHome, 'evidence', 'staging'),
        })
      )
    },
  }
  const pipeline = input.selection?.pipeline ?? {
    ...nativeBinding('AW_PIPELINE_MOCK_URL'),
    effects: native.pipeline,
    staging: {
      collect: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-pipeline-sink-',
      }),
      trigger: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-pipeline-trigger-',
      }),
      rerun: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-pipeline-rerun-',
      }),
    },
  }
  const approval = input.selection?.approval ?? {
    ...nativeBinding('AW_APPROVAL_MOCK_URL'),
    effects: native.approval,
    staging: createLocalEvidenceStagingFactory(content, {
      kind: 'temporary',
      prefix: 'aw-approval-adapter-',
    }),
  }
  assertPurposePair(
    requirement,
    ['acquire', 'questionsWriteback', 'answersCollect'],
    [requirement.staging],
  )
  // The selected writer is checked without evaluating the default native writer early.
  if (
    input.selection?.requirement !== undefined &&
    typeof requirement.documentCommands?.writeDocument !== 'function'
  ) {
    throw new Error('development-purpose-document-commands-incomplete')
  }
  assertPurposePair(
    pipeline,
    ['collect', 'trigger', 'rerun'],
    [pipeline.staging.collect, pipeline.staging.trigger, pipeline.staging.rerun],
  )
  assertPurposePair(approval, ['submit', 'lookup', 'observe'], [approval.staging])
  return {
    requirement,
    pipeline,
    approval,
    get evidenceArtifacts() {
      return artifacts()
    },
  }
}
