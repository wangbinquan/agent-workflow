// Provider-neutral route mounts and HTTP request pipeline.
import { type RunObservation } from '@/modules/run-observability/composition/runObservation'
import type {
  DirectAuthorityAdmission,
  DirectAuthorityBinding,
  HttpAuthenticationParticipant,
} from '@/modules/identity-access/public/participants'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { composeHttpAuthenticationMiddleware } from '@/modules/identity-access/composition/authentication'
import type { composeWebhookIngressTransport } from '@/modules/integration/composition/webhookIngress'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { bindExecutionAvailability } from '@/platform/http/executionAvailability'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import { Hono } from 'hono'
import { actorOf, tryActorOf } from '@/auth/actor'
import { takeDeleteSnapshot } from '@/services/tokenAudit'
import { assertRouteMetaCoverage, registerRoute } from '@/routes/registry'
import type { IntegrationTriggerResourceBinding } from '@/services/scheduledTasks'
import { getEmbeddedFrontendResponse, IS_EMBEDDED, type FrontendDeploymentMode } from '@/embed'
import { mountMcpTransport } from '@/mcp/server'
import { assertOperationCatalogClosed, registerOperationAlias } from '@/platform/operations/catalog'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import { directMcpOperationAuthority } from '@/routes/operationAuthority'
import { mountAgentRoutes } from '@/routes/agents'
import { mountAuthRoutes } from '@/routes/auth'
import { mountBackupRoutes } from '@/routes/backup'
import { mountDatabaseMigrationRoutes } from '@/routes/databaseMigrations'
import { mountRestoreRoutes } from '@/routes/restore'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import { mountRepoGroupRoutes } from '@/routes/repoGroups'
import { mountConfigRoutes } from '@/routes/config'
import { mountDaemonRoutes } from '@/routes/daemon'
import { mountDocsRoutes, mountWellKnownRoutes } from '@/routes/docs'
import { mountHealthRoutes } from '@/routes/health'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import { type IdentityAccessRuntime } from '@/modules/identity-access/composition'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { executionStatusOf } from '@/modules/system-operations/composition'
import { SYSTEM_OPERATION_ALIASES } from '@/modules/system-operations/public/operations'
import { mountMcpRoutes } from '@/routes/mcps'
import { mountMemoryRoutes } from '@/routes/memories'
import { mountMemoryDistillJobRoutes } from '@/routes/memoryDistillJobs'
import { type RepositoryMirrors } from '@/modules/source-control/composition'
import { mountTaskFeedbackRoutes } from '@/routes/taskFeedback'
import { mountOverviewRoutes } from '@/routes/overview'
import { mountOidcRoutes } from '@/routes/oidc'
import { mountOidcAuthRoutes } from '@/routes/oidc-auth'
import { mountPlantumlRoutes } from '@/routes/plantuml'
import { mountPluginRoutes } from '@/routes/plugins'
import { mountUserRoutes } from '@/routes/users'
import { mountRepoRoutes } from '@/routes/repos'
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
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountWorktreeFilesRoutes } from '@/routes/worktree-files'
import { mountPortArtifactRoutes } from '@/routes/port-artifacts'
import { errorHandler } from '@/util/errors'
import { createLogger } from '@/util/log'

export type IntegrationTriggerIdentityAccess = IdentityAccessRuntime & {
  readonly integrationTriggerResources: IntegrationTriggerResourceBinding
  readonly taskExecutionResources: TaskExecutionResourceBinding
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

export interface AppHttpProviderCore {
  readonly provider: DatabaseProvider
  readonly authRuntime: AuthRuntime
  readonly tokenCallAudit: TokenCallAuditParticipant
  readonly identityAccess: {
    readonly directAuthority: DirectAuthorityAdmission & DirectAuthorityBinding
  }
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
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
  readonly configuration: ApplicationConfigurationQueries
  readonly authentication: HttpAuthenticationParticipant
  readonly core: TCore
  readonly publicRoutes: AppPublicRouteMounts
  readonly apiRoutes: AppApiRouteMounts
  readonly executionAuthority: ExecutionAuthorityPort
}

export type ProviderComposedAppDeps<TCore extends AppHttpProviderCore = AppHttpProviderCore> =
  ComposedAppDeps<TCore>

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
    readonly graph: Parameters<typeof mountDigitalEmployeeRoutes>[5]
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
  TCore extends AppHttpProviderCore = AppHttpProviderCore,
> {
  readonly token: string
  readonly configuration: ApplicationConfigurationQueries
  readonly authentication: HttpAuthenticationParticipant
  readonly core: TCore
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
  /** RFC-370 v2 H7: bootstrap-selected execution authority (RFC-392: always supplied). */
  readonly executionAuthority: ExecutionAuthorityPort
}

export type SqliteAppCompositionInput = ProviderAppCompositionInput<
  AppHttpProviderCore & { readonly provider: 'sqlite' }
>

export type PostgresqlAppCompositionInput = ProviderAppCompositionInput<
  AppHttpProviderCore & { readonly provider: 'postgresql' }
>

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
export function composeProviderAppDeps<TCore extends AppHttpProviderCore>(
  input: ProviderAppCompositionInput<TCore>,
): ProviderComposedAppDeps<TCore> {
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
        input.digitalDevelopment.digitalEmployees.graph,
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

/**
 * Every `/api/*` route in its canonical order.  Provider composition supplies
 * closed bindings, but cannot add, remove or reorder route domains.
 */
export function mountApiRoutes(app: Hono, deps: ComposedAppDeps): void {
  bindExecutionAvailability(app, () => executionStatusOf(deps.executionAuthority))
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
  /** RFC-370 M0 — states the deployment to the embedded SPA. */
  readonly deploymentMode: FrontendDeploymentMode
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
      const response = await getEmbeddedFrontendResponse(c.req.path, undefined, deps.deploymentMode)
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
    deploymentMode: deps.executionAuthority.mode,
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
