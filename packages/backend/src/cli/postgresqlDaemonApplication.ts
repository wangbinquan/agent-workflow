// RFC-349 — PostgreSQL daemon application composition.
//
// This file is intentionally a bootstrap composition root. Provider clients
// are captured while owner modules are built and never cross into HTTP, WS or
// public route contracts.

import {
  createClarifyDecisionCommand,
  createQuestionDispatchCommand,
  createReviewDecisionCommand,
  createTaskDagCollaborationOperations,
} from '@/modules/collaboration/composition/legacySqliteDecisionCommands'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import { composePostgresqlSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { recoverInterruptedTaskDeletes } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import {
  createDaemonLockProof,
  runTaskExecutionBootRecovery,
} from '@/modules/task-execution/composition/bootRecovery'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import {
  WORKFLOW_SCHEMA_VERSION,
  parseTriggerContextJson,
  serializeWorkflowDefinitionStorageV1,
  type Config,
} from '@agent-workflow/shared'
import { join } from 'node:path'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import { eq } from 'drizzle-orm'

import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import { loadConfig } from '@/config'
import { actorOfDirectAuthority, admitDaemonIdentity } from '@/auth/session'
import {
  createPostgresqlIdentityAccessCrossContextBindings,
  composePostgresqlOidcIdentityOperations,
} from '@/modules/identity-access/composition/providerOperations'
import { DrizzleOidcProviderRepository } from '@/modules/identity-access/public/operations'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { composePostgresqlOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import {
  composePostgresqlRepositoryWorkspaceStore,
  composeRepositoryTransportCredentials,
  createRepositoryPublicationTransport,
  PostgresqlRepositoryTransportCredentialRepository,
  reconcileRepositoryTransportConnectionProjections,
} from '@/modules/source-control/composition'
import { composePostgresqlCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composePostgresqlLegacyCodeReadProviders } from '@/modules/code-capability/composition/legacyCodeReads'
import {
  composePostgresqlCapabilityTemplateOperations,
  createPostgresqlCapabilityTemplatePackageMutationOwner,
  createPostgresqlCapabilityTemplatePersistence,
} from '@/modules/code-capability/composition/capabilityTemplateOperations'
import {
  composePostgresqlMemoryOperations,
  composeSkillMemoryFusionParticipantFactory,
} from '@/modules/memory/composition'
import { composePostgresqlResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'
import { composePostgresqlResourceCatalog } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composePostgresqlClassicCatalogs } from '@/modules/resource-catalog/composition/postgresqlClassicCatalogs'
import { composePostgresqlResourceCatalogOverviewQuery } from '@/modules/resource-catalog/composition/resourceCatalogOverview'
import { composePostgresqlMcpProbeStore } from '@/modules/resource-catalog/composition/mcpProbeStore'
import {
  composePostgresqlMcpRuntimeTestProvider,
  createPostgresqlMcpTransactionLifecycle,
} from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composePostgresqlMcpCatalog } from '@/modules/resource-catalog/composition/mcpOperations'
import { composePostgresqlPluginCatalog } from '@/modules/resource-catalog/composition/pluginOperations'
import { composePostgresqlWorkgroupCatalog } from '@/modules/resource-catalog/composition/workgroupOperations'
import { composePostgresqlWorkgroupTaskRoom } from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import { composePostgresqlDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { initialBuiltinResourceAcl } from '@/modules/resource-catalog/application/resourceDefaults'
import { composePostgresqlTaskExecutionResourceSnapshotFactory } from '@/modules/resource-catalog/composition/taskExecution'
import { composePostgresqlWorkgroupTurnsOperations } from '@/modules/resource-catalog/composition/workgroupTurns'
import { composePostgresqlIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { tasks, workflows } from '@/db/schema'
import { legacyTaskExecutionResourceDependencies } from '@/services/execution/legacyTaskExecutionResourceDependencies'
import { createPostgresqlTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/postgresqlTaskExecutionResourceSnapshots'
import { composePostgresqlAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import {
  composePostgresqlTaskExecutionProviderRuntime,
  type SelectedPostgresqlTaskExecutionProviderRuntime,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import { createPostgresqlTaskExecutionCatalogSourceFactory } from '@/modules/task-execution/composition/taskExecutionRuntime'
import { composeTaskExecutionCatalogSources } from '@/modules/task-execution/application/adapters/task-catalog-adapter'
import { createPostgresqlTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composePostgresqlNodeRunLifecycleParticipantFactory } from '@/modules/task-execution/composition/nodeRunLifecycle'
import { composePostgresqlWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { composePostgresqlDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import type { TaskDriveCoordinator } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { resolveTaskDriveConfig } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { createPostgresqlTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/postgresqlTaskDriverLifecycle'
import {
  composePostgresqlWorkgroupTaskRoomClarifyParticipantFactory,
  createPostgresqlCollaborationCommandContext,
  createPostgresqlCollaborationRuntimeMechanics,
} from '@/modules/collaboration/composition'
import { composePostgresqlCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import {
  readCommittedReviewArtifactBody,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { createPostgresqlCollaborationTaskAccessPort } from '@/modules/collaboration/composition'
import { composePostgresqlWorkspaceMaintenanceCommand } from '@/modules/source-control/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import {
  composeExecutionContract,
  createPostgresqlExecutionContractResourceAdapter,
} from '@/modules/execution-contract/composition'
import {
  composeDigitalEmployeePlatformInventoryParticipant,
  composeDigitalEmployeeAgentTemplateCatalogParticipant,
  composeDigitalEmployeeTaskCatalogSource,
  composePostgresqlDigitalEmployee,
  composeDigitalEmployeeBootstrapReadsFor,
  composePostgresqlDigitalEmployeeWriterCutover,
  createDigitalEmployeeResourceCatalogAclProviders,
  createEmployeeInputArtifactStore,
  createPostgresqlEmployeeReactionRoundQueries,
  createReactionExecutionAdapter,
} from '@/modules/digital-employee/composition'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { composePostgresqlDigitalEmployeeExecution } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composePostgresqlResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import {
  composeTaskIdleTimeoutOperations,
  createPostgresqlTaskIdleTimeoutPersistence,
  type TaskIdleTimeoutOperations,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import { readTaskResourceUsage } from '@/services/limits'
import {
  composePostgresqlDevelopmentAdmissionLookup,
  composePostgresqlDevelopmentAutomation,
} from '@/modules/development-automation/composition'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composePostgresqlDevelopmentEmployeeWorkspace,
  createPostgresqlDevelopmentEmployeeCaseWorkspaceDetailReader,
} from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeDevelopmentEmployeeCaseDetailProjection } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import { composePostgresqlDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { createDevelopmentActivityWorkerBinding } from '@/modules/development-automation/composition/activityOperations'
import {
  composePostgresqlDevelopmentConfigOperations,
  type DevelopmentConfigResourceAccess,
} from '@/modules/development-automation/composition/configOperations'
import {
  composePostgresqlDevelopmentMissionOperations,
  createLegacyMissionAdmissionsEnabledQuery,
} from '@/modules/development-automation/composition/missionOperations'
import { composePostgresqlMissionInputUploadOperations } from '@/modules/development-automation/composition/missionInputUploads'
import { composePostgresqlRequirementSourceRunner } from '@/modules/integration/composition/requirementSource'
import { composePostgresqlDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import { composeDevelopmentAdapterConfigOperationsFor } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { composeForeignResourceAclFor } from '@/modules/resource-catalog/composition/resourceAcl'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/composition'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentMrFactsDeps,
  buildDevelopmentPipelineDeps,
  createDevelopmentWorkspaceRepositoryPreparation,
} from '@/services/developmentDeliveryDeps'
import type { DigitalEmployeeAclResourceType } from '@/routes/digitalEmployees'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import { composePostgresqlIntentPersistence } from '@/modules/intent/composition/persistence'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '@/modules/intent/composition/auxiliaryQueries'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import {
  composePostgresqlIntentApplyOperations,
  createIntentSessionWsPublisher,
} from '@/modules/intent/composition/apply'
import { createPostgresqlIntentApplyOperations } from '@/modules/intent/infrastructure/postgresqlIntentApplyOperations'
import { createPostgresqlIntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import {
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '@/modules/resource-catalog/composition/intentApply'
import { composePostgresqlIntentApplyResourceBinding } from '@/modules/resource-catalog/composition/intentApply'
import { composePostgresqlIntentContextResourceAuthorizationFactory } from '@/modules/resource-catalog/composition/intentContextAuthorization'
import { composeIntentResourceCatalogFor } from '@/modules/intent/application/resourceCatalog'
import { composePostgresqlFusionOperations } from '@/modules/knowledge-evolution/composition/fusion'
import { composePostgresqlIntentMaintenanceSnapshotQueries } from '@/modules/intent/composition/maintenance'
import { composePostgresqlTaskSourceTermination } from '@/modules/task-execution/composition/sourceTermination'
import { composePostgresqlScheduledTaskRuntime } from '@/modules/integration/composition/scheduledTasks'
import {
  composeWebhookLaunchAdmission,
  composeWebhookTriggerValidation,
} from '@/modules/integration/composition/webhookAdmission'
import { createAsyncSkillRestoreMembership } from '@/modules/knowledge-evolution/public/participants'
import {
  composePostgresqlWebhookDispatchPersistence,
  composePostgresqlWebhookTriggerServiceDependencies,
  createPostgresqlWebhookExecutionRuntime,
} from '@/modules/integration/composition/webhookDispatch'
import { composePostgresqlWebhookEndpointServiceDependencies } from '@/modules/integration/composition/webhookEndpoints'
import {
  composePostgresqlWebhookDeliveryRuntime,
  composePostgresqlWebhookIngressPersistence,
} from '@/modules/integration/composition/webhookIngress'
import { composePostgresqlWebhookDeliveryPersistence } from '@/modules/integration/composition/webhookDelivery'
import { composePostgresqlMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'
import { createPostgresqlWebhookRepositoryResolver } from '@/modules/integration/infrastructure/webhookRepositoryResolver'
import {
  createDeferredDigitalEmployeeWorkStart,
  createPostgresqlCodeHostWebhookDeliveryConsumer,
  createPostgresqlCodeHostWebhookRoutingDirectory,
} from '@/modules/integration/composition'
import {
  composeDevelopmentApprovalEventObserver,
  composeDevelopmentCodeHostEventObserver,
  composeDevelopmentEmployeeEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import { composePostgresqlApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composePostgresqlEventCenter } from '@/modules/event-center/composition'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'
import { collaborationCommittedEventCatalogJson } from '@/modules/collaboration/public/events'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { createPostgresqlMissionCodeHostEventContinuation } from '@/modules/development-automation/composition'
import type { DevelopmentAutomationModule } from '@/modules/development-automation/composition'
import { createPostgresqlDevelopmentMissionExecutionTerminalObserver } from '@/modules/development-automation/composition/executionTerminalObserver'
import { composePostgresqlAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composePostgresqlScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { composeSystemOverviewQuery } from '@/modules/system-operations/application/overview'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { composePostgresqlWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { cleanupOrphanedGitCredentialLeases } from '@/util/gitCredentialLease'
import { recoverInterruptedDeliveries } from '@/services/webhook/deliveryStore'
import { Paths } from '@/util/paths'
import { composePostgresqlDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composePostgresqlCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { setChildTaskBudgetCapacity } from '@/services/execution/childBudget'
import { materializingSpaces } from '@/services/gc'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { runtimeConfigOpts } from '@/services/task'
import {
  validateWorkflowDef,
  type ValidatorContext,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow.validator'
import { createLogger } from '@/util/log'
import { runFrameBackfillOnBoot } from '@/modules/task-execution/composition/frameBackfill'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { triggerRevalidationAndWait } from '@/ws/revalidationHook'
import type { DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResolvedDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { getMcpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { createOidcProvidersService } from '@/services/oidcProviders'
import { createCodeHostConnectionsService } from '@/services/codeHost/connections'
import { createRepositoryEndpointDiscovery } from '@/modules/integration/composition'
import { createPostgresqlDevelopmentDeliveryProvider } from '@/modules/development-automation/composition'
import { composePostgresqlPipelineEvidenceRunner } from '@/modules/integration/composition/pipelineEvidence'
import { resolveDevelopmentRepoBinding } from '@/services/developmentDeliveryDeps'
import { getProbeByMcpId } from '@/services/mcpProbeStore'
import { composePostgresqlSkillArtifactCompensation } from '@/modules/resource-catalog/composition/intentApply'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'
import {
  mcpOperationCoordinator,
  pluginOperationCoordinator,
} from '@/services/resourceOperationCoordinator'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import { mcpRouteNow } from '@/routes/mcps'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { directRequestAuthority } from '@/routes/operationAuthority'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import {
  composePostgresqlAppDeps,
  composePostgresqlDaemonProviderCore,
  composeDigitalEmployeeRoutePersistence,
  createComposedApp,
  type PostgresqlAppCompositionInput,
  type SelectedDaemonProviderCore,
} from '@/server'
import { buildWebSocketAdapter } from '@/ws/server'
import type { FusedIntoSkillMemory, MemoryScopeAuthority } from '@/modules/memory/public/catalog'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { PRESENCE_CHANNEL, presenceBroadcaster } from '@/ws/broadcaster'
import { createDaemonRealtimePolicyBinding } from './daemonRealtimePolicy'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import { createWebhookDispatcher } from '@/services/webhook/webhookDispatch'
import { validateDynamicWorkflowDef } from '@/services/orchestratorAgent'
import { ConflictError } from '@/util/errors'
import { assertNotBuiltin } from '@/services/systemResources'
import {
  resumeQueuedIntentWorkingSets,
  type IntentDispatchDeps,
} from '@/modules/intent/application/dispatcher'
import { composeIntentWorkflowGraphValidation } from '@/modules/intent/composition/graphValidation'

const log = createLogger('postgresql-daemon-application')

const WORKGROUP_HOST_WORKFLOW_ID = '00000000000000WORKGROUP00'
const WORKGROUP_HOST_WORKFLOW_NAME = '__workgroup_host__'

function isDigitalEmployeeAclType(type: string): type is DigitalEmployeeAclResourceType {
  return (
    type === 'employee_definition' || type === 'employee_tool' || type === 'employee_job_template'
  )
}

type PostgresqlProviderRuntime = Extract<
  ResolvedDatabaseProviderRuntime,
  { readonly provider: 'postgresql' }
>

export interface PostgresqlDaemonApplicationInput {
  readonly provider: PostgresqlProviderRuntime
  readonly db: PostgresqlDatabaseClient
  readonly config: Config & {
    readonly database: Extract<Config['database'], { readonly provider: 'postgresql' }>
  }
  readonly token: string
  readonly appHome: string
  readonly configPath: string
  readonly daemonInfoPath: string
  readonly lockPath: string
  readonly secretBox: SecretBox
  /** RFC-349 T10 — see `DatabaseSourceWriteWindow`; bootstrap supplies the live one. */
  readonly sourceWriteWindow?: DatabaseSourceWriteWindow
  readonly databaseMigration: DatabaseMigrationModule
  readonly dbVersion: number
  readonly maintenanceStatus: NonNullable<
    PostgresqlAppCompositionInput['platform']['maintenance']['maintenanceStatus']
  >
}

export interface PostgresqlDaemonApplication {
  readonly core: SelectedDaemonProviderCore<'postgresql'>
  readonly app: ReturnType<typeof createComposedApp>
  readonly webSocket: ReturnType<typeof buildWebSocketAdapter>
  readonly runtime: PostgresqlDaemonApplicationRuntime
}

/**
 * Closed daemon-lifetime participants selected together with the HTTP graph.
 * The start command owns timers and workers; it receives no route dependency
 * builders and cannot accidentally re-compose a second provider graph.
 */
export interface PostgresqlDaemonApplicationRuntime {
  readonly taskExecution: SelectedPostgresqlTaskExecutionProviderRuntime
  readonly scheduledTasks: ReturnType<typeof composePostgresqlScheduledTaskRuntime>
  readonly scheduledTaskIdentityAccess: TaskExecutionBackgroundStartDependencies['scheduled']['identityAccess']
  readonly memory: ReturnType<typeof composePostgresqlMemoryOperations>
  readonly developmentAutomation: ReturnType<typeof composePostgresqlDevelopmentAutomation>
  readonly digitalEmployee: ReturnType<typeof composePostgresqlDigitalEmployee>
  readonly eventCenter: Awaited<ReturnType<typeof composePostgresqlEventCenter>>
  readonly fusion: ReturnType<typeof composePostgresqlFusionOperations>
  readonly resourceLimits: ReturnType<typeof composePostgresqlResourceLimitOperations>
  /** RFC-350：不活跃超时收割（僵尸任务）的 provider-bound operations。 */
  readonly taskIdleTimeout: TaskIdleTimeoutOperations
  readonly mcpRuntimeTests: ReturnType<typeof getMcpRuntimeTestService>
  readonly webhookTerminalControl: ReturnType<typeof composePostgresqlMrTerminalControl>
  readonly workspaceMaintenance: ReturnType<typeof composePostgresqlWorkspaceMaintenanceCommand>
  readonly intentMaintenance: ReturnType<typeof composePostgresqlIntentMaintenanceSnapshotQueries>
  readonly resourcePackageActivity: Pick<
    ReturnType<typeof createPostgresqlResourcePackageAtomicApplyOperations>,
    'activeApplyIds'
  >
  readonly resumeIntentSessions: (sessionIds: readonly string[]) => Promise<void>
  readonly driveHumanGateContinuation: (input: {
    readonly taskId: string
    readonly continuationRef: string
  }) => Promise<void>
}

/**
 * Build one complete PostgreSQL HTTP/WS graph from the already verified live
 * generation. The implementation is filled by the owner-domain compositions
 * below; callers never reopen or reselect a provider.
 */
export async function composePostgresqlDaemonApplication(
  input: PostgresqlDaemonApplicationInput,
): Promise<PostgresqlDaemonApplication> {
  const realtimePolicy = createDaemonRealtimePolicyBinding()
  const core = composePostgresqlDaemonProviderCore({
    db: input.db,
    ...(input.sourceWriteWindow === undefined
      ? {}
      : { sourceWriteWindow: input.sourceWriteWindow }),
    runtime: input.provider.runtime,
    databaseConfig: input.config.database,
    appHome: input.appHome,
    lockPath: input.lockPath,
    secretBox: input.secretBox,
    realtimePolicy: realtimePolicy.policy,
    onCredentialRevoked: triggerRevalidation,
    identityCrossContext: createPostgresqlIdentityAccessCrossContextBindings(),
    identityEvents: {
      authorityRevisionChanged({ userId, revision, onFailure }) {
        triggerAuthorityRevalidation(userId, revision, onFailure)
      },
    },
    presenceProjection: {
      publish(changes) {
        const [head, ...rest] = changes
        if (head === undefined) return
        presenceBroadcaster.broadcast(PRESENCE_CHANNEL, {
          type: 'presence.changed',
          changes: [head, ...rest],
        })
      },
    },
  })
  // Cold restore is a provider boot hook, not an HTTP/background operation.
  // Apply it while admission is still closed and before any owner module reads
  // the selected schema. A live non-empty target is rejected by the restore
  // coordinator; bootstrap never drops or aliases the active schema.
  await core.systemOperations.applyPendingRestore()

  // RFC-300 / RFC-359 W3-T15（P1-12）：终态工作区回收策略——integration 判 Webhook 归属，lifecycle 在终态
  // CAS 里写认领，GC 物理删除；每次转移时读配置，开关热生效。此前 PG daemon 从未注册，
  // `webhookTaskWorkspaceAutoCleanup` 在 PG 上完全无效、worktree 永不回收。
  registerTerminalWorkspacePrunePolicy(
    composePostgresqlWebhookTerminalWorkspacePrunePolicy({
      db: input.db,
      enabled: () => loadConfig(input.configPath).webhookTaskWorkspaceAutoCleanup,
    }),
  )
  const removedCredentialLeases = cleanupOrphanedGitCredentialLeases(input.appHome)
  if (removedCredentialLeases > 0) {
    log.info('orphaned git credential leases removed', { count: removedCredentialLeases })
  }

  // RFC-223 PR-5 / RFC-359 W1-T7d（P0-11）：技能身份屏障是 DB 就绪后的第一件事——恢复遗留结构操作、
  // 清理崩溃残留的 skill_operation_locks / reserving 行、证明 DB/FS/FK 一致，然后才允许任何消费方
  // 读技能。fail-closed：不包 try，屏障失败即 daemon 不起。此前 PG daemon 从未装配它。
  const skillCatalogBoot = composePostgresqlSkillCatalogBoot({
    db: input.db,
    appHome: input.appHome,
  })
  {
    const report = await skillCatalogBoot.runIdentityMigrationBarrier()
    if (report.recoveredOperations > 0 || report.removedHusks > 0 || report.migratedSkills > 0) {
      log.info('skill identity migration barrier complete', { ...report })
    }
  }
  // 启动期可用性闸：每个技能先隐藏，逐个 reverify 通过后才放行（bootReverifyActivated）。
  skillCatalogBoot.activateAvailabilityGate()

  const identityAccess = core.identityAccess
  // daemon 自用的系统身份也必须由注册表**铸**出来。授权句柄按对象引用从
  // `AuthorityClaimRegistry` 的 WeakMap 里取（只有 `mintDirectAuthority` 会往里写），
  // 手捏的投影会被 `authorityForLegacyProjection` 抛 `foreign-legacy-actor-projection`
  // ——本文件下面四条 daemon 自用路径（动态工作流校验上下文、工作组启动的
  // `loadExistingAgentIds`、数字员工执行的 `agents.get` / `workflows.get` 与
  // `resourceAuthorityFor`）全都吃这一对句柄。`__system__` 由迁移 0018 播种且不可禁用，
  // admit 不出来说明这个库根本没法用，宁可在启动时带名字失败。
  const systemIdentity = await admitDaemonIdentity(identityAccess)
  if (systemIdentity === null) throw new Error('postgresql-daemon-system-identity-not-admitted')
  const systemActor = actorOfDirectAuthority(systemIdentity)
  const resourceCatalog = composePostgresqlResourceCatalog({ db: input.db })
  let collaborationContext: Parameters<typeof readCommittedReviewArtifactBody>[0] | null = null
  const memoryOperations = composePostgresqlMemoryOperations({
    db: input.db,
    reviewedArtifacts: {
      async read(finalPath) {
        if (collaborationContext === null) {
          throw new Error('collaboration-command-context-not-bound')
        }
        return await readCommittedReviewArtifactBody(collaborationContext, finalPath)
      },
    },
    catalogBinding: {
      contexts: identityAccess.contexts,
      authorization: composePostgresqlResourceScopeAccessParticipant(),
    },
  })
  const memoryCatalog = memoryOperations.catalog
  if (memoryCatalog === undefined) throw new Error('postgresql-memory-catalog-not-composed')
  const classicCatalogs = composePostgresqlClassicCatalogs({
    db: input.db,
    appHome: input.appHome,
    runtimeProfiles: { get: (name) => core.runtimeRegistry.getRuntime(name) },
    // RFC-353 T7：回滚该退回哪些记忆归 knowledge-evolution 裁定；它消费 memory 的
    // participant，resource-catalog 只收到一个「给事务、还 id」的窄端口。
    restoreMembership: createAsyncSkillRestoreMembership(
      composeSkillMemoryFusionParticipantFactory(),
    ),
    resourceCatalog,
  })
  const mcpProbeStore = composePostgresqlMcpProbeStore(input.db)
  let mcpCatalogRef: ReturnType<typeof composePostgresqlMcpCatalog> | null = null
  const mcpRuntimeTests = getMcpRuntimeTestService({
    ...composePostgresqlMcpRuntimeTestProvider(input.db),
    async loadMcp(mcpId) {
      if (mcpCatalogRef === null) throw new Error('mcp-catalog-not-composed')
      const identity = await admitDaemonIdentity(identityAccess)
      if (identity === null) throw new Error('mcp-runtime-test-authority-not-admitted')
      return await mcpCatalogRef.queries.get(identity.actor, { id: mcpId })
    },
    loadRuntime: (name) => core.runtimeRegistry.getRuntime(name),
    configPath: input.configPath,
    appHome: input.appHome,
  })
  const mcpCatalog = composePostgresqlMcpCatalog({
    db: input.db,
    lifecycle: createPostgresqlMcpTransactionLifecycle(),
    resourceCatalog,
    coordinator: mcpOperationCoordinator,
    async nextMutationTimestamp(mcp) {
      const persisted = await getProbeByMcpId(mcpProbeStore, mcp.id)
      return mcpOperationCoordinator.nextCausalTimestamp(mcp.id, mcpRouteNow(), [
        mcp.updatedAt + 1,
        (persisted?.startedAt ?? 0) + 1,
        mcpOperationCoordinator.activeLastStartedAt(mcp.id) + 1,
      ])
    },
    runtime: Object.freeze({
      prepareDelete: (mcpId: string) => mcpRuntimeTests.prepareMcpDelete(mcpId),
      reconcileDurableIntents: () => mcpRuntimeTests.reconcileDurableIntents(),
    }),
  })
  mcpCatalogRef = mcpCatalog
  const pluginCatalog = composePostgresqlPluginCatalog({
    db: input.db,
    resourceCatalog,
    coordinator: pluginOperationCoordinator,
  })
  const workgroupCatalog = composePostgresqlWorkgroupCatalog({
    db: input.db,
    resourceCatalog,
  })
  const digitalEmployeeAgentTemplates =
    composePostgresqlDigitalEmployeeAgentTemplateCatalogParticipant(
      input.db,
      composeDigitalEmployeeAgentTemplateCatalogParticipant,
    )
  const authorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
  const oidcIdentities = composePostgresqlOidcIdentityOperations({
    db: input.db,
    identityAccess,
  })
  const oidcProviders = createOidcProvidersService({
    repository: new DrizzleOidcProviderRepository(input.db),
    secretBox: input.secretBox,
  })
  const identityUserOperations = composeIdentityUserOperations({
    identityAccess,
    auth: core.authRuntime,
    afterDisabled: async () => await mcpRuntimeTests.reconcileDurableIntents(),
  })

  const repositoryWorkspaceStore = composePostgresqlRepositoryWorkspaceStore(input.db)
  const repositoryTransportRepository = new PostgresqlRepositoryTransportCredentialRepository(
    input.db,
  )
  const repositoryTransport = composeRepositoryTransportCredentials(
    repositoryTransportRepository,
    input.secretBox,
  )
  await reconcileRepositoryTransportConnectionProjections(
    repositoryTransportRepository,
    repositoryTransport.adminConnections,
  )
  const codeHostConnections = createCodeHostConnectionsService({
    secretBox: input.secretBox,
    repositoryTransport: repositoryTransport.adminConnections,
  })
  const repositoryEndpointDiscovery = createRepositoryEndpointDiscovery({
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
  })
  const repositoryPublicationTransport = createRepositoryPublicationTransport({
    repository: repositoryTransportRepository,
    secretBox: input.secretBox,
    appHome: input.appHome,
    endpointDiscovery: repositoryEndpointDiscovery,
  })
  const developmentDeliveryProvider = createPostgresqlDevelopmentDeliveryProvider({
    db: input.db,
    secretBox: input.secretBox,
    connections: codeHostConnections,
    pipeline: composePostgresqlPipelineEvidenceRunner(input.db),
  })

  const codeHistoryQueries = composePostgresqlCodeHistoryQueries(input.db)
  const executionContracts = composeExecutionContract({
    resources: createPostgresqlExecutionContractResourceAdapter(
      input.db,
      developmentImplicitAgentContractDeclarations,
    ),
    appHome: input.appHome,
    registrations: developmentExecutionContractRegistrations,
    implicitAgentDeclarations: developmentImplicitAgentContractDeclarations,
  })
  const capabilityTemplatePersistence = createPostgresqlCapabilityTemplatePersistence(input.db)
  const capabilityTemplateOperations = composePostgresqlCapabilityTemplateOperations({
    db: input.db,
    access: {
      filterVisible: (actor, rows) =>
        resourceCatalog.authorization.filterVisibleRows(actor, 'capability_template', rows),
      canView: (actor, row) =>
        resourceCatalog.authorization.canViewResource(actor, 'capability_template', row),
      requireEdit: (actor, row) =>
        resourceCatalog.authorization.requireResourceEdit(actor, 'capability_template', row),
      requireGovern: (actor, row) =>
        resourceCatalog.authorization.requireResourceGovern(actor, 'capability_template', row),
      assertNameUnchangedForEditor: resourceCatalog.authorization.assertNameUnchangedForEditor,
    },
  })
  type CapabilityTemplateAclRow = Readonly<{
    id: string
    ownerUserId: string | null
    visibility: 'private' | 'public'
  }>
  const capabilityTemplateAcl = Object.freeze({
    load: (id: string) => capabilityTemplatePersistence.load(id),
    canView: (actor: Actor, row: CapabilityTemplateAclRow) =>
      resourceCatalog.authorization.canViewResource(actor, 'capability_template', row),
    read: (actor: Actor, row: CapabilityTemplateAclRow) =>
      resourceCatalog.acl.getResourceAcl(actor, 'capability_template', row),
    update: (
      actor: Actor,
      row: CapabilityTemplateAclRow,
      body: Parameters<typeof resourceCatalog.acl.updateResourceAcl>[3],
      updatedAt?: number,
    ) =>
      resourceCatalog.acl.updateResourceAcl(actor, 'capability_template', row, body, {
        ...(updatedAt === undefined ? {} : { updatedAt }),
      }),
  })

  type PostgresqlResourcePackageProviderInput = Parameters<
    typeof composePostgresqlResourcePackageProvider
  >[0]
  type PackageAuthority = Parameters<
    PostgresqlResourcePackageProviderInput['authorityResolver']['resolve']
  >[0]
  const packageActors = new WeakMap<PackageAuthority, Actor>()
  const resourcePackageProvider = composePostgresqlResourcePackageProvider({
    db: input.db,
    appHome: input.appHome,
    authorityResolver: Object.freeze({
      resolve(authority: PackageAuthority) {
        const actor = packageActors.get(authority)
        if (actor === undefined) throw new Error('foreign-resource-package-authority')
        return actor
      },
    }),
    mcpLifecycle: createPostgresqlMcpTransactionLifecycle(),
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db: input.db }),
    pluginInstaller: Object.freeze({
      plannedGenerationDirectory(
        request: Parameters<
          PostgresqlResourcePackageProviderInput['pluginInstaller']['plannedGenerationDirectory']
        >[0],
      ) {
        return plannedGenerationDir(
          request.pluginId,
          request.spec,
          request.generationId,
          request.pluginsDir,
        )
      },
      async install(
        request: Parameters<
          PostgresqlResourcePackageProviderInput['pluginInstaller']['install']
        >[0],
      ) {
        const installed = await installPlugin(request.pluginId, request.spec, {
          generationId: request.generationId,
          pluginsDir: request.pluginsDir,
        })
        return {
          cachedPath: installed.cachedPath,
          resolvedVersion: installed.resolvedVersion,
          sourceKind: installed.sourceKind,
          generationDirectory: installed.generationDir,
        }
      },
    }),
  })
  const resourcePackageAtomicApply = createPostgresqlResourcePackageAtomicApplyOperations({
    db: input.db,
    box: input.secretBox,
  })
  const resourcePackageCatalog = composePostgresqlResourcePackageCatalog({
    provider: resourcePackageProvider,
    execution: createPostgresqlResourcePackageExecutionAdapter({
      box: input.secretBox,
      provider: resourcePackageProvider,
      atomicApply: resourcePackageAtomicApply,
    }),
  })
  const taskExecutionResourceSnapshots = composePostgresqlTaskExecutionResourceSnapshotFactory(
    legacyTaskExecutionResourceDependencies,
  )
  const taskExecutionResources = createPostgresqlTaskExecutionResourceBinding(
    input.db,
    taskExecutionResourceSnapshots,
  )
  const taskExecutionPersistence = createPostgresqlTaskExecutionPersistence(input.db)
  const nodeRunLifecycle = composePostgresqlNodeRunLifecycleParticipantFactory()
  const collaborationRuntime = createPostgresqlCollaborationRuntimeMechanics(input.db, {
    taskRuntime: { humanGates: taskExecutionPersistence.humanGateLifecycle },
    nodeRunLifecycle,
  })
  const boundCollaborationContext = createPostgresqlCollaborationCommandContext({
    db: input.db,
    appHome: input.appHome,
    taskExecutionReadModels: taskExecutionPersistence.reads,
    // RFC-359 W1-T2a：问题派发命令端口与 SQLite 是同一份实现；此前这里从未注入，路由必 500。
    questionDispatches: createQuestionDispatchCommand(input.db),
    // RFC-359 W1-T2b：快速澄清决定同样是一份实现；蒸馏入队走 PG 侧的 memory 命令面。
    clarifyDecisions: createClarifyDecisionCommand(input.db, memoryOperations.distillCommands),
    // RFC-359 W1-T2c：评审决定同样是一份实现（决定 / 评论 / 选择五个事务体跑在 DatabaseSession 上）。
    reviewDecisions: createReviewDecisionCommand({ db: input.db, appHome: input.appHome }),
  })
  collaborationContext = boundCollaborationContext
  const workgroupClarify = composePostgresqlWorkgroupTaskRoomClarifyParticipantFactory()
  const workgroupTurns = composePostgresqlWorkgroupTurnsOperations(
    input.db,
    composePostgresqlWorkgroupHostLedgerParticipantFactory({
      collaboration: workgroupClarify,
    }),
    // RFC-359 W1-T7e：反问许可（预算 / 已问次数 / stop 指令）与 SQLite 同一份判定。
    createWorkgroupClarifyAskGate(input.db),
  )
  // RFC-359 W1-T1（P0-7）：派发管线跑在 DatabaseSession 上，两个 provider 共用同一份投影；
  // 此前这里是一个从未被 bind 的 holder，每个 tick 抛 deferred-question-dispatcher-not-bound。
  const taskDagCollaboration = createTaskDagCollaborationOperations(input.db)
  const workspaceMaintenance = composePostgresqlWorkspaceMaintenanceCommand({
    db: input.db,
    appHome: input.appHome,
    terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: invalidateCallGraphIndex,
  })

  const validationContext = Object.freeze({
    async load(): Promise<ValidatorContext> {
      const authority = authorityFor(systemActor)
      const [agents, skills, mcps, plugins] = await Promise.all([
        classicCatalogs.agent.queries.list(authority),
        classicCatalogs.skill.queries.list(authority),
        mcpCatalog.queries.list(authority),
        pluginCatalog.queries.list(authority),
      ])
      return {
        agents: [...agents],
        skills: [...skills],
        mcps: [...mcps],
        plugins: [...plugins],
      }
    },
  })
  const agentLaunchResources = composePostgresqlAgentLaunchResourceOperations({
    db: input.db,
    agents: {
      get: (actor, agentId) =>
        classicCatalogs.agent.queries.get(authorityFor(actor), { id: agentId }),
    },
    workflowValidation: {
      async validate(definition) {
        return validateWorkflowDef(definition, await validationContext.load())
      },
    },
  })
  const workgroupLaunchResources = Object.freeze({
    loadVisible: (actor: Actor, workgroupId: string) =>
      workgroupCatalog.queries.get(authorityFor(actor), { id: workgroupId }),
    async loadExistingAgentIds(agentIds: readonly string[]): Promise<readonly string[]> {
      const authority = authorityFor(systemActor)
      const rows = await Promise.all(
        agentIds.map((id) => classicCatalogs.agent.queries.get(authority, { id })),
      )
      return rows.flatMap((row) => (row === null ? [] : [row.id]))
    },
    async ensureHostWorkflow(): Promise<void> {
      await input.db
        .insert(workflows)
        .values({
          id: WORKGROUP_HOST_WORKFLOW_ID,
          name: WORKGROUP_HOST_WORKFLOW_NAME,
          description: 'RFC-164 workgroup host anchor — do not launch directly',
          definition: serializeWorkflowDefinitionStorageV1({
            $schema_version: WORKFLOW_SCHEMA_VERSION,
            inputs: [],
            nodes: [],
            edges: [],
          }),
          ...initialBuiltinResourceAcl(null),
          builtin: true,
        })
        .onConflictDoNothing({ target: workflows.id })
        .run()
    },
    integrity: classicCatalogs.agentResourceIntegrity.launch,
  })

  let taskExecutionProviderRef: SelectedPostgresqlTaskExecutionProviderRuntime | null = null
  let taskDriveCoordinatorRef: TaskDriveCoordinator | null = null
  const taskDriveCoordinator: TaskDriveCoordinator = Object.freeze({
    async submit(request: Parameters<TaskDriveCoordinator['submit']>[0]) {
      if (taskDriveCoordinatorRef === null) throw new Error('task-drive-coordinator-not-bound')
      return await taskDriveCoordinatorRef.submit(request)
    },
  })
  const launchRuntime = resolveLaunchRuntimeConfig(input.configPath)
  const runConfig = Object.freeze({
    appHome: input.appHome,
    configPath: input.configPath,
    daemonGeneration: input.provider.runtime.generationId,
    ...runtimeConfigOpts(launchRuntime),
  })
  const taskExecutionProvider = composePostgresqlTaskExecutionProviderRuntime(input.db, {
    runtime: {
      taskDagCollaboration,
      collaborationRuntime,
      workgroupTurns,
      identityAccess: Object.freeze({
        delegatedRequests: identityAccess.delegatedRequests,
        taskExecutionResources,
      }),
      codeHostConnections,
      repositoryPublicationTransport,
      dynamicWorkflow: Object.freeze({
        persistence: composePostgresqlDynamicWorkflowPersistence(input.db),
        validationContext,
      }),
      processConcurrencyScope: input.provider.runtime,
      daemonGeneration: input.provider.runtime.generationId,
      finalizeWorkspace: (taskId) => workspaceMaintenance.finalizeClaimedWorkspace(taskId),
      log,
      persistence: taskExecutionPersistence,
    },
    rootResumeRuntime: () => ({ runConfig }),
    routeWorkspace: {
      appHome: input.appHome,
      secretBox: input.secretBox,
      cloneTimeoutMs: launchRuntime.cloneTimeoutMs,
    },
    routeLaunch: {
      configPath: input.configPath,
      gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
      coordinator: taskDriveCoordinator,
      resourceAuthorityFor: (actor) => ({
        actor,
        authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
        resources: taskExecutionResources,
      }),
      agent: {
        resources: agentLaunchResources,
        integrity: classicCatalogs.agentResourceIntegrity.launch,
      },
      workgroup: workgroupLaunchResources,
    },
    routes: () => ({
      collaboration: boundCollaborationContext,
      users: identityAccess.userDirectory,
      owners: composePostgresqlOwnerIdentityQueries(input.db),
      membershipEvents: {
        async committed(change) {
          await triggerRevalidationAndWait('task-members-changed')
          const visibleUserIds = new Set<string>()
          if (change.previousOwnerUserId !== null) visibleUserIds.add(change.previousOwnerUserId)
          if (change.ownerUserId !== null) visibleUserIds.add(change.ownerUserId)
          for (const userId of change.previousMemberUserIds) visibleUserIds.add(userId)
          for (const userId of change.memberUserIds) visibleUserIds.add(userId)
          tasksListBroadcaster.broadcast(
            TASKS_LIST_CHANNEL,
            { type: 'task.members.changed', taskId: change.taskId },
            { kind: 'task.members-changed-audience', taskId: change.taskId, visibleUserIds },
          )
        },
      },
      deletionEvents: {
        async committed(change) {
          for (const taskId of change.taskIds) {
            tasksListBroadcaster.broadcast(
              TASKS_LIST_CHANNEL,
              { type: 'task.deleted', taskId },
              {
                kind: 'task.deleted-audience',
                taskId,
                visibleUserIds: change.visibleUserIdsByTask.get(taskId) ?? new Set<string>(),
              },
            )
          }
        },
      },
      appHome: input.appHome,
    }),
    lifecycleRepair: {
      onAlert(row, transition) {
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'lifecycle.alert',
          taskId: row.taskId,
          rule: row.rule,
          severity: row.severity,
          transition,
        })
      },
      onResolved(taskId) {
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'lifecycle.alert.resolved',
          taskId,
        })
      },
    },
    fusion: { appHome: input.appHome },
    workgroupTaskRoom: { collaboration: workgroupClarify },
  })
  taskExecutionProviderRef = taskExecutionProvider
  const taskDriverLifecycle = createPostgresqlTaskDriverLifecyclePort({
    db: input.db,
    module: taskExecutionProvider.executionModule,
    persistence: taskExecutionProvider.persistence,
    log,
    finalizeWorkspace: (taskId) => workspaceMaintenance.finalizeClaimedWorkspace(taskId),
  })
  taskDriveCoordinatorRef = new DefaultTaskDriveCoordinator({
    runtime: resolveTaskDriveConfig(runConfig),
    lifecycle: taskDriverLifecycle,
    repositoryPreparation: skipRepositoryPreparation,
    engineOrchestrator: {
      async drive(context) {
        const selected = taskExecutionProviderRef
        if (selected === null) throw new Error('task-execution-provider-not-bound')
        await selected.runtime.schedulerDriver.drive({
          taskId: context.taskId,
          appHome: context.runtime.appHome,
          ...context.runtime.runtime,
          ...(context.runtime.ensureWorkspaceProfiles ? { ensureWorkspaceProfiles: true } : {}),
          signal: context.signal,
          executionContext: context.execution,
        })
      },
    },
    failureReporter: {
      async report({ taskId, error, execution }) {
        const now = Date.now()
        await taskExecutionProvider.persistence.runtimeLifecycle.trySet({
          taskId,
          to: 'failed',
          allowedFrom: ['pending', 'running'],
          extra: {
            finishedAt: now,
            errorSummary: 'task drive failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          executionContext: execution,
          now,
          reason: 'task-drive',
        })
        await taskExecutionProvider.persistence.intentTerminalization.terminalize({
          taskId,
          state: 'failed',
          failureCode: 'task-drive-failed',
          now,
          claimedOwnerEpoch: execution.token.epoch,
        })
      },
    },
  })

  const codeWorkspace = composePostgresqlLegacyCodeReadProviders(input.db).workspace
  const collaborationTaskAccess = createPostgresqlCollaborationTaskAccessPort(input.db)
  const taskRoutes = Object.freeze({
    configPath: input.configPath,
    operations: taskExecutionProvider.routes.tasks,
    taskExecutionReadModels: taskExecutionProvider.readModels,
    taskRecoveryOperations: taskExecutionProvider.recovery,
    codeWorkspace,
    repositoryWorkspace: core.repositoryWorkspaceStore,
    changeNarrative: Object.freeze({
      async requireMember(actor: Actor, taskId: string) {
        const access = await resolveCollaborationTaskAccess(boundCollaborationContext, {
          actor,
          taskId,
        })
        if (access.task === null) {
          const { NotFoundError } = await import('@/util/errors')
          throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        }
        if (access.actorRole === null) {
          const { ForbiddenError } = await import('@/util/errors')
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
      }) => core.runtimeRegistry.resolveRuntimeByName(runtimeName ?? defaultRuntime),
    }),
  })
  const worktreeFiles = Object.freeze({
    store: core.repositoryWorkspaceStore,
    canViewTask: async (actor: Actor, task: { readonly id: string }) =>
      (await collaborationTaskAccess.resolveTask(actor, task.id)).visible,
  })
  const collaborationRouteOperations = composePostgresqlCollaborationRouteOperations({
    db: input.db,
    context: boundCollaborationContext,
    taskNodeLifecycle: nodeRunLifecycle,
  })
  const fusionOperations = composePostgresqlFusionOperations({
    // RFC-353 T6/T7：同 SQLite 侧——provider 装配只在 bootstrap 根上完成。
    memoryMembership: composeSkillMemoryFusionParticipantFactory(),
    skillVersionCommit: composeSkillVersionCommitParticipantFactory(),
    db: input.db,
    appHome: input.appHome,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.fusion,
  })
  // RFC-223 PR-4 / RFC-359 W3-T15：融合 provenance 修复必须在任何融合恢复 / 播种 / HTTP 观察到历史
  // name-only 行之前完成。fail-closed：不包 try，修复失败即 daemon 不起（与 cli/start.ts 同）。
  {
    const { repairFusionProvenance } =
      await import('@/modules/knowledge-evolution/public/operations')
    const report = await repairFusionProvenance(fusionOperations.persistence)
    if (Object.values(report).some((count) => count > 0)) {
      log.info('fusion provenance repair complete', { ...report })
    }
  }
  const taskExecutionCatalogSources = composeTaskExecutionCatalogSources(
    // RFC-357：目录源不再经 `routes.tasks.listItems` 把行拉进内存，改用与 SQLite 共用的
    // 下推页查询；owner 身份由这里注入（模块自己去 compose 别的 context 是被判红的形状）。
    createPostgresqlTaskExecutionCatalogSourceFactory(
      input.db,
      composePostgresqlOwnerIdentityQueries(input.db),
    ),
  )
  const workgroupTaskRoom = composePostgresqlWorkgroupTaskRoom({
    db: input.db,
    taskParticipantFactory: taskExecutionProvider.workgroupTaskRoom,
    activeUsers: {
      async findActiveUserIds(userIds) {
        const users = await identityAccess.userDirectory.lookup(userIds)
        return new Set(users.filter((user) => user.status === 'active').map((user) => user.id))
      },
    },
    dynamicWorkflow: {
      async validateGenerated(authority, request) {
        assertTriggerPreflight({
          root: request.definition,
          closureJson: null,
          source: parseTriggerContextJson(request.triggerContextJson),
        })
        const generic = validateWorkflowDef(request.definition, await validationContext.load())
        const dynamic = validateDynamicWorkflowDef(request.definition, request.poolAgentIds)
        const issues = [...generic.issues, ...dynamic.issues].filter(
          (issue) => (issue.severity ?? 'error') === 'error',
        )
        if (issues.length > 0) {
          throw new ConflictError(
            'dw-generated-def-stale',
            'the generated workflow no longer validates against the current agent pool — reject with feedback to regenerate',
            { issues },
          )
        }
        return request.definition
      },
      async create(authority, request) {
        const created = await classicCatalogs.workflow.operations.create.invoke(authority, {
          submission: {
            kind: 'json-body',
            body: JSON.stringify(request),
          },
        })
        return { id: created.id, name: created.name }
      },
    },
    systemUserId: SYSTEM_USER_ID,
    broadcast(taskId, event) {
      taskBroadcaster.broadcast(TASK_CHANNEL(taskId), { id: -1, ...event })
    },
  })

  const integrationTriggerSnapshots = composePostgresqlIntegrationTriggerResourceSnapshotFactory({
    assertNotBuiltin,
  })
  const scheduledTaskRuntime = composePostgresqlScheduledTaskRuntime({
    db: input.db,
    resourceSnapshots: integrationTriggerSnapshots,
    validation: Object.freeze({
      async assertWorkflowLaunchable(workflow) {
        const result = validateWorkflowDef(workflow.definition, await validationContext.load())
        const errors = result.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
        if (errors.length > 0) {
          throw new ConflictError(
            'workflow-invalid',
            errors[0]?.message ?? 'workflow is not launchable',
            { issues: errors },
          )
        }
      },
      assertAgentIntegrity: (agentIds) =>
        classicCatalogs.agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
    } satisfies Parameters<typeof composePostgresqlScheduledTaskRuntime>[0]['validation']),
    resourceAclChanged: () => triggerRevalidation('resource-acl-changed'),
  })
  const integrationIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionResources,
  })
  const digitalEmployeeWorkStart = createDeferredDigitalEmployeeWorkStart()
  const webhookDeliveryRuntime = composePostgresqlWebhookDeliveryRuntime(input.db)
  const webhookTerminalControl = composePostgresqlMrTerminalControl({
    db: input.db,
    taskTermination: composePostgresqlTaskSourceTermination(input.db),
  })
  await webhookTerminalControl.reconcileOnBoot()
  const recoveredDeliveries = await recoverInterruptedDeliveries(
    composePostgresqlWebhookDeliveryPersistence(input.db),
  )
  if (recoveredDeliveries > 0) {
    log.info('webhook deliveries marked interrupted', { count: recoveredDeliveries })
  }
  // RFC-354 T4 — one-shot frame backfill for rows minted before frames existed
  // (marker-gated; a single maintenance_state read on every later boot).
  try {
    const backfill = await runFrameBackfillOnBoot({ provider: 'postgresql', db: input.db })
    if (!backfill.skipped) {
      log.info('rfc354 frame backfill completed on boot', {
        tasks: backfill.tasks,
        rowsUpdated: backfill.rowsUpdated,
        roundsUpdated: backfill.roundsUpdated,
        unreadableTasks: backfill.unreadableTasks.length,
        unresolvedRows: backfill.unresolvedRows,
      })
    }
  } catch (err) {
    log.warn('rfc354 frame backfill on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const webhookDispatcher = createWebhookDispatcher({
    persistence: composePostgresqlWebhookDispatchPersistence(input.db),
    deliveryPersistence: composePostgresqlWebhookDeliveryPersistence(input.db),
    identityAccess: integrationIdentityAccess,
    async resolveEventTargetAuthority(userId) {
      const admitted = await identityAccess.localOperator.forLegacyHttpUser(userId)
      if (admitted === null) return null
      return Object.freeze({
        authority: admitted.commandContext().authority,
        actor: admitted.actor,
      })
    },
    getDefaultRuntime: async () => loadConfig(input.configPath).defaultRuntime,
    ...createPostgresqlWebhookExecutionRuntime({
      taskExecutions: taskExecutionProvider.trigger.taskExecutions,
      digitalEmployeeWorkStart: digitalEmployeeWorkStart.participant,
    }),
    resolveRepo: createPostgresqlWebhookRepositoryResolver(input.db, input.secretBox),
    admitLaunch: composeWebhookLaunchAdmission(scheduledTaskRuntime.operations),
    terminalControl: webhookTerminalControl,
  })
  const developmentApprovalGateway = composePostgresqlApprovalGatewayRunner(input.db)
  const missionEventContinuation = createPostgresqlMissionCodeHostEventContinuation(input.db)
  const eventCenter = await composePostgresqlEventCenter({
    db: input.db,
    typePackageDescriptorJsons: [
      developmentEmployeeTypePackage.descriptorJson,
      codeHostEventCatalogJson,
      taskLifecycleEventCatalogJson,
      collaborationCommittedEventCatalogJson,
      digitalEmployeeLifecycleEventCatalogJson,
    ],
    observer: composeDevelopmentEmployeeEventObserver({
      codeHost: composeDevelopmentCodeHostEventObserver({
        binding: (repositoryId) =>
          resolveDevelopmentRepoBinding(developmentDeliveryProvider, repositoryId),
      }),
      approval: composeDevelopmentApprovalEventObserver({ gateway: developmentApprovalGateway }),
    }),
    routingSubscriptions: createPostgresqlCodeHostWebhookRoutingDirectory(
      input.db,
      missionEventContinuation,
    ),
    automationWorkStart: { launch: (request) => webhookDispatcher.dispatchEventTarget(request) },
    deliveryConsumers: [
      createPostgresqlCodeHostWebhookDeliveryConsumer(
        input.db,
        webhookDispatcher,
        missionEventContinuation,
      ),
    ],
    deliveryRetryLimits: {
      current() {
        const current = loadConfig(input.configPath)
        return {
          defaultNodeRetries: current.defaultNodeRetries,
          sessionRestartBudget: current.sessionRestartBudget,
        }
      },
    },
  })
  const webhookTriggerService = composePostgresqlWebhookTriggerServiceDependencies(
    input.db,
    composeWebhookTriggerValidation(scheduledTaskRuntime.operations, input.configPath),
  )
  const integrationRoutes: PostgresqlAppCompositionInput['integration'] = Object.freeze({
    scheduledTasks: Object.freeze({
      identityAccess: integrationIdentityAccess,
      scheduledTaskRuntime,
      buildScheduleLaunch: taskExecutionProvider.trigger.buildScheduleLaunch,
      getDefaultRuntime: () => loadConfig(input.configPath).defaultRuntime ?? null,
    }),
    webhookEndpoints: Object.freeze({
      webhookEndpointService: composePostgresqlWebhookEndpointServiceDependencies({
        db: input.db,
        configPath: input.configPath,
        secretBox: input.secretBox,
      }),
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

  const employeeInputArtifacts = createEmployeeInputArtifactStore(
    join(input.appHome, 'artifacts', 'employee-inputs'),
  )
  const employeeReactionRounds = createPostgresqlEmployeeReactionRoundQueries(input.db)
  const employeeWorkspace = composePostgresqlDevelopmentEmployeeWorkspace({
    db: input.db,
    appHome: input.appHome,
    reactionRounds: employeeReactionRounds,
    inputArtifacts: employeeInputArtifacts,
    repositoryPreparation: createDevelopmentWorkspaceRepositoryPreparation({
      store: repositoryWorkspaceStore,
      appHome: input.appHome,
      secretBox: input.secretBox,
    }),
    sourceControl: bindEmployeeCaseWorkspaceParticipant({
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
  })
  const employeeDelivery = buildDevelopmentDeliveryDeps(developmentDeliveryProvider)
  const employeePlatformWorkItems = composePostgresqlDevelopmentEmployeePlatformWorkItems({
    db: input.db,
    appHome: input.appHome,
    reactionRounds: employeeReactionRounds,
    approvalGateway: developmentApprovalGateway,
    ...employeeDelivery,
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
  })
  const taskLaunchKernel = taskExecutionProvider.routeLaunch.workflow
  if (taskLaunchKernel === undefined) {
    throw new Error('postgresql-task-launch-kernel-not-composed')
  }
  const resourceLimitOperations = composePostgresqlResourceLimitOperations({
    db: input.db,
    cancelTask: (taskId) =>
      taskExecutionProvider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
  })
  // RFC-350：收割器与资源上限走同一条终结路径（cancel + 覆盖专用原因文案）；
  // `user` 是 TaskCancellationCommand 今天仅有的非级联 cause，用户可见的原因由
  // `writeIdleTimeoutReason` 覆盖出来，与 limits 先例完全同形。
  const taskIdleTimeoutOperations = composeTaskIdleTimeoutOperations({
    persistence: createPostgresqlTaskIdleTimeoutPersistence(input.db),
    cancelTask: (taskId) =>
      taskExecutionProvider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
  })
  const employeeExecution = composePostgresqlDigitalEmployeeExecution({
    appHome: input.appHome,
    actor: systemActor,
    resourceAuthorityFor: (actor) => ({
      actor,
      authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
      resources: taskExecutionResources,
    }),
    launch: taskLaunchKernel,
    tasks: taskExecutionProvider.routes.tasks,
    readModels: taskExecutionProvider.readModels,
    resourceUsage: {
      read: (taskId) => readTaskResourceUsage(resourceLimitOperations, taskId),
    },
    agents: {
      get: (id) => classicCatalogs.agent.queries.get(authorityFor(systemActor), { id }),
    },
    workflows: {
      get: (id) => classicCatalogs.workflow.queries.get(authorityFor(systemActor), { id }),
    },
    executionMetadata: {
      async load(taskId) {
        const row = await input.db
          .select({
            roundRef: tasks.digitalEmployeeRoundId,
            autoRecoverySuspended: tasks.autoRecoverySuspended,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get()
        return row ?? null
      },
    },
    workspace: employeeWorkspace,
    executionContracts,
  })
  const persistedTypePackages = await composeDigitalEmployeeBootstrapReadsFor(
    input.db,
  ).listTypePackageDescriptorJsons()
  const digitalEmployee = composePostgresqlDigitalEmployee({
    db: input.db,
    appHome: input.appHome,
    typePackages: [developmentEmployeeTypePackage],
    platformTools: await composeDigitalEmployeeBuiltinToolCatalog({
      agentTemplates: digitalEmployeeAgentTemplates,
      typePackageDescriptorJsons: [
        ...persistedTypePackages,
        developmentEmployeeTypePackage.descriptorJson,
      ],
    }),
    onAutomaticUpgradeIssue(issue) {
      log.warn('automatic digital employee type upgrade could not prove compatibility', {
        ...issue,
      })
    },
    executionContracts,
    retryLimits: {
      current() {
        const current = loadConfig(input.configPath)
        return {
          defaultNodeRetries: current.defaultNodeRetries,
          sessionRestartBudget: current.sessionRestartBudget,
        }
      },
    },
    inputArtifacts: employeeInputArtifacts,
    connectionCatalog: composePostgresqlDevelopmentToolConnectionCatalog(input.db),
    runtime: {
      eventCenter: eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      detailProjectionParticipants: [
        composeDevelopmentEmployeeCaseDetailProjection(
          createPostgresqlDevelopmentEmployeeCaseWorkspaceDetailReader(input.db),
        ),
      ],
      execution: createReactionExecutionAdapter(employeeExecution),
      platformWorkItems: employeePlatformWorkItems,
    },
  })
  await composePostgresqlDigitalEmployeeWriterCutover(input.db).activate()
  await digitalEmployee.maintenance.settleAutomaticUpgrades()
  if (digitalEmployee.runtime === null) {
    throw new Error('postgresql-digital-employee-runtime-not-composed')
  }
  digitalEmployeeWorkStart.bind({
    async launch(request) {
      const result = await digitalEmployee.runtime!.commands.launchWork({
        employeeId: request.employeeId,
        intake: request.intake,
        actorUserId: request.actorUserId,
        eventOrigin: request.origin,
      })
      return { caseId: result.caseRef.id }
    },
  })
  const developmentActivity = createDevelopmentActivityWorkerBinding()
  developmentActivity.bind(digitalEmployee.runtime.worker)

  const developmentAdmissionLookup = composePostgresqlDevelopmentAdmissionLookup(input.db)
  const developmentConfigAccess: DevelopmentConfigResourceAccess = {
    filterVisible: (actor, type, rows) =>
      resourceCatalog.authorization.filterVisibleRows(actor, type, rows),
    canView: (actor, type, row) => resourceCatalog.authorization.canViewResource(actor, type, row),
    requireEdit: (actor, type, row) =>
      resourceCatalog.authorization.requireResourceEdit(actor, type, row),
    requireGovern: (actor, type, row) =>
      resourceCatalog.authorization.requireResourceGovern(actor, type, row),
    assertNameUnchangedForEditor: resourceCatalog.authorization.assertNameUnchangedForEditor,
  }
  // RFC-359 W4-D6：development-adapter 配置与 SQLite 根同一份装配；它的 ACL 也改走目录的中立 foreign-owner 路径。
  const developmentAdapter = composeDevelopmentAdapterConfigOperationsFor({
    db: input.db,
    access: developmentConfigAccess,
    grants: resourceCatalog.persistence.grants,
  })
  const developmentAdapterAcl = composeForeignResourceAclFor({
    db: input.db,
    identity: developmentAdapter.resourceAclIdentity,
  })
  const developmentConfig = composePostgresqlDevelopmentConfigOperations({
    db: input.db,
    developmentAdapter,
    access: developmentConfigAccess,
  })
  // RFC-359 W1-T3（F-H2-2）：agent / script 动作 launcher 与执行终态观察者——与 cli/start.ts 同一份
  // 执行器（actionExecutionRunners.ts），只是宿主任务的启动 / 取消换成 PG 的根启动内核与取消命令。
  // 此前 PG daemon 一个都没接，development mission 的每个动作都被 `*-launcher-not-wired` 挡下。
  const developmentAutomationRef: { current: DevelopmentAutomationModule | null } = {
    current: null,
  }
  const developmentTerminalObserver = createPostgresqlDevelopmentMissionExecutionTerminalObserver({
    db: input.db,
    async drive(missionId) {
      const current = developmentAutomationRef.current
      if (current === null) throw new Error('development-automation-not-composed')
      try {
        const outcome = await current.drive(missionId)
        if (outcome.stop === 'step-budget') {
          log.warn('development mission drive reached its bounded step budget', {
            missionId,
            steps: outcome.steps,
          })
        }
        return outcome
      } catch (err) {
        log.warn('development mission drive after execution terminal failed', {
          missionId,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  })
  const actionExecutionEnvironment = {
    db: input.db,
    actor: systemActor,
    resourceAuthorityFor: (actor: Actor) => ({
      actor,
      authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
      resources: taskExecutionResources,
    }),
    launch: taskLaunchKernel,
    cancelTask: (taskId: string) =>
      taskExecutionProvider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
    readModels: taskExecutionProvider.readModels,
    agents: {
      get: (id: string) => classicCatalogs.agent.queries.get(authorityFor(systemActor), { id }),
    },
  }
  const developmentAutomation = composePostgresqlDevelopmentAutomation({
    db: input.db,
    appHome: input.appHome,
    admissionLookup: developmentAdmissionLookup,
    requirementSource: composePostgresqlRequirementSourceRunner(input.db),
    changeCandidate: bindChangeCandidateParticipant(),
    candidateDelivery: bindCandidateDeliveryParticipant({
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
    ...buildDevelopmentDeliveryDeps(developmentDeliveryProvider),
    ...buildDevelopmentPipelineDeps(developmentDeliveryProvider.pipeline),
    ...buildDevelopmentMrFactsDeps(developmentDeliveryProvider),
    approvalGateway: developmentApprovalGateway,
    agentLauncher: composePostgresqlAgentActionExecution({
      ...actionExecutionEnvironment,
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.agent(executionRef)
      },
    }),
    scriptLauncher: composePostgresqlScriptActionExecution({
      ...actionExecutionEnvironment,
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.script(executionRef)
      },
    }),
  })
  developmentAutomationRef.current = developmentAutomation
  const developmentMissions = composePostgresqlDevelopmentMissionOperations({
    db: input.db,
    deliveryProvider: developmentDeliveryProvider,
    admissionLookup: developmentAdmissionLookup,
    automation: developmentAutomation,
    legacyAdmissionsEnabled: createLegacyMissionAdmissionsEnabledQuery(
      composePostgresqlDigitalEmployeeWriterCutover(input.db),
    ),
  })
  // RFC-359 W4-D6c：employee_* 的 ACL 与 SQLite 根同一条目录中立 foreign-owner 路径，identity 行由
  // digital-employee 在目录写事务里交出；PG 专属的 foreign ACL 适配器退役。
  const digitalEmployeeAclIdentityProviders = createDigitalEmployeeResourceCatalogAclProviders(
    input.db,
  )
  const digitalEmployeeAcl = Object.freeze({
    employee_definition: composeForeignResourceAclFor({
      db: input.db,
      identity: digitalEmployeeAclIdentityProviders.employeeDefinition,
    }),
    employee_tool: composeForeignResourceAclFor({
      db: input.db,
      identity: digitalEmployeeAclIdentityProviders.employeeTool,
    }),
    employee_job_template: composeForeignResourceAclFor({
      db: input.db,
      identity: digitalEmployeeAclIdentityProviders.employeeJobTemplate,
    }),
  })
  const digitalEmployeePersistence = composeDigitalEmployeeRoutePersistence({
    identityAccess,
    resourceCatalog,
    acl: {
      getResourceAcl: (actor, type, row) =>
        digitalEmployeeAcl[type].getResourceAcl(actor, type, row),
      updateResourceAcl: (actor, type, row, body, options) =>
        digitalEmployeeAcl[type].updateResourceAcl(actor, type, row, body, {
          ...(options?.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        }),
    },
  })
  const developmentAclRoutes: PostgresqlAppCompositionInput['digitalDevelopment']['developmentConfig']['aclRoutes'] =
    Object.freeze({
      mount(
        request: Parameters<
          PostgresqlAppCompositionInput['digitalDevelopment']['developmentConfig']['aclRoutes']['mount']
        >[0],
      ) {
        mountAclEndpoints(request.app, {
          type: request.type,
          base: request.base,
          param: 'id',
          load: request.load,
          canView: (actor, row) =>
            request.type === 'development_adapter'
              ? resourceCatalog.authorization.canViewResource(actor, request.type, row)
              : resourceCatalog.authorization.canViewResource(actor, request.type, row),
          read: (actor, row) =>
            request.type === 'development_adapter'
              ? developmentAdapterAcl.getResourceAcl(actor, request.type, row)
              : isDigitalEmployeeAclType(request.type)
                ? digitalEmployeeAcl[request.type].getResourceAcl(actor, request.type, row)
                : resourceCatalog.acl.getResourceAcl(actor, request.type, row),
          update: (actor, row, body, updatedAt) =>
            request.type === 'development_adapter'
              ? developmentAdapterAcl.updateResourceAcl(actor, request.type, row, body, {
                  ...(updatedAt === undefined ? {} : { updatedAt }),
                })
              : isDigitalEmployeeAclType(request.type)
                ? digitalEmployeeAcl[request.type].updateResourceAcl(
                    actor,
                    request.type,
                    row,
                    body,
                    {
                      ...(updatedAt === undefined ? {} : { updatedAt }),
                    },
                  )
                : resourceCatalog.acl.updateResourceAcl(actor, request.type, row, body, {
                    ...(updatedAt === undefined ? {} : { updatedAt }),
                  }),
          notFoundCode: request.notFoundCode,
        })
      },
    })
  const digitalDevelopmentRoutes: PostgresqlAppCompositionInput['digitalDevelopment'] =
    Object.freeze({
      executionContracts,
      digitalEmployees: Object.freeze({
        persistence: digitalEmployeePersistence,
        module: digitalEmployee,
        activityOperations: developmentActivity.operations,
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
      missionInputUploads: composePostgresqlMissionInputUploadOperations({
        db: input.db,
        appHome: input.appHome,
      }),
    })

  const intentAuthorityFor = (actor: Actor) => authorityFor(actor)
  const intentCatalogActors = new WeakMap<object, Actor>()
  const intentResourceCatalogFor = composeIntentResourceCatalogFor({
    query: resourceCatalog.createQuery({
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
      agents: classicCatalogs.agent.queries,
      skills: classicCatalogs.skill.queries,
      skillFiles: classicCatalogs.skill.fileQueries,
      mcps: mcpCatalog.queries,
      plugins: pluginCatalog.queries,
      workflows: classicCatalogs.workflow.queries,
      workgroups: workgroupCatalog.queries,
    },
  })
  const intentPersistence = composePostgresqlIntentPersistence({
    db: input.db,
    contextAuthorization: composePostgresqlIntentContextResourceAuthorizationFactory(),
  })
  const intentArtifactRecovery = createPostgresqlIntentApplyArtifactLifecycle({
    skillArtifacts: composePostgresqlSkillArtifactCompensation(),
    db: input.db,
    appHome: input.appHome,
    pluginsDir: join(input.appHome, 'plugins'),
  })
  const intentApplyOperations = createPostgresqlIntentApplyOperations({
    db: input.db,
    // RFC-358 §7（AC-6）—— 与 SQLite provider 同一道门、同一份判据。
    graphValidation: composeIntentWorkflowGraphValidation({
      validationQueries: classicCatalogs.workflow.validationQueries,
      workflowQueries: classicCatalogs.workflow.queries,
      authorityFor,
    }),
    resources: composePostgresqlIntentApplyResourceBinding({
      db: input.db,
      mcpLifecycle: createPostgresqlMcpTransactionLifecycle(),
      pluginArtifacts: createPostgresqlIntentPluginArtifactLifecycle({
        pluginsDir: join(input.appHome, 'plugins'),
      }),
      skillArtifacts: createPostgresqlIntentSkillArtifactLifecycle({
        appHome: input.appHome,
      }),
      aclIdentities: resourceCatalog.persistence.identities,
    }),
    artifacts: intentArtifactRecovery,
  })
  const intentApply = composePostgresqlIntentApplyOperations(intentApplyOperations)
  const intentPlatformInventory = composeIntentPlatformInventoryParticipant({
    authorityFor: intentAuthorityFor,
    capabilityTemplates: capabilityTemplateOperations,
    developmentConfig,
    digitalEmployee: composeDigitalEmployeePlatformInventoryParticipant({
      queries: digitalEmployee.queries,
      access: resourceCatalog.authorization,
    }),
  })
  const intentDumpAuxiliary = composeIntentDumpAuxiliaryQueries({
    persistence: intentPersistence,
    defaultRuntime: loadConfig(input.configPath).defaultRuntime ?? 'opencode',
    platformInventory: intentPlatformInventory,
  })
  const intentSessionEvents = createIntentSessionWsPublisher()
  const intentDispatchDeps: Omit<IntentDispatchDeps, 'configSnapshot'> = Object.freeze({
    persistence: intentPersistence,
    events: intentSessionEvents,
    identityAccess: Object.freeze({ directAuthority: identityAccess.directAuthority }),
    appHome: input.appHome,
    runtimeResolver: composeIntentTurnRuntimeResolver(intentPersistence),
    dumpAuxiliary: intentDumpAuxiliary,
    // RFC-358: 两个 provider 的意图链路跑同一份图校验合同。
    graphValidation: composeIntentWorkflowGraphValidation({
      validationQueries: classicCatalogs.workflow.validationQueries,
      workflowQueries: classicCatalogs.workflow.queries,
      authorityFor,
    }),
    resourceCatalogFor: intentResourceCatalogFor,
  })
  const intentMaintenance = composePostgresqlIntentMaintenanceSnapshotQueries({
    db: input.db,
    activity: intentApplyOperations,
  })
  const intentRoutes: PostgresqlAppCompositionInput['intent'] = Object.freeze({
    configPath: input.configPath,
    events: intentSessionEvents,
    identityAccess,
    directAuthority: identityAccess.directAuthority,
    intentApply,
    intentPersistence,
    intentTurnRuntime: Object.freeze({
      runtimeResolver: composeIntentTurnRuntimeResolver(intentPersistence),
      dumpAuxiliary: intentDumpAuxiliary,
      graphValidation: composeIntentWorkflowGraphValidation({
        validationQueries: classicCatalogs.workflow.validationQueries,
        workflowQueries: classicCatalogs.workflow.queries,
        authorityFor,
      }),
    }),
    resourceCatalogFor: intentResourceCatalogFor,
  })
  const taskCatalog = composeTaskCatalog({
    sources: [
      ...taskExecutionCatalogSources,
      composeDigitalEmployeeTaskCatalogSource(digitalEmployee.runtime),
    ],
  })

  const publicRoutes: PostgresqlAppCompositionInput['public'] = Object.freeze({
    health: Object.freeze({
      deps: Object.freeze({ opencodeVersion: null, dbVersion: input.dbVersion }),
      identityAccess: identityAccess.diagnostics,
      database: core.healthDatabase,
    }),
    documentation: Object.freeze({ configPath: input.configPath }),
    webhookIngress: Object.freeze({
      webhookIngressPersistence: composePostgresqlWebhookIngressPersistence(input.db),
      secretBox: input.secretBox,
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher,
      webhookTerminalControl,
    }),
  })

  const overviewActors = new WeakMap<object, Actor>()
  const resourceCatalogOverview = composePostgresqlResourceCatalogOverviewQuery(input.db, {
    resolve(authority) {
      const actor = overviewActors.get(authority)
      if (actor === undefined) throw new Error('foreign-overview-authority')
      return actor
    },
  })
  const systemOverview = composeSystemOverviewQuery({
    resourceCatalog: resourceCatalogOverview,
    repositories: core.repositoryWorkspaceOperations.overviewQueries,
    integration: scheduledTaskRuntime.overview,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.overview,
  })
  const overviewQuery: PostgresqlAppCompositionInput['platform']['overview']['query'] =
    Object.freeze({
      async execute(request: Parameters<typeof systemOverview.execute>[0]) {
        overviewActors.set(request.authority, request.actor)
        return await systemOverview.execute(request)
      },
    })
  const platformRoutes: PostgresqlAppCompositionInput['platform'] = Object.freeze({
    config: Object.freeze({
      configPath: input.configPath,
      runtimeRegistry: core.runtimeRegistry,
      runtimeTests: mcpRuntimeTests,
      concurrencyHotApply: Object.freeze({
        apply(
          next: Parameters<
            PostgresqlAppCompositionInput['platform']['config']['concurrencyHotApply']['apply']
          >[0],
        ) {
          resizeAllNodePools(input.provider.runtime, {
            agent: next.maxConcurrentNodes,
            script: next.maxConcurrentScriptNodes,
            'code-host': next.maxConcurrentCodeHostCalls,
          })
          resizeAllTaskFanoutSems(next.multiProcessSubprocessConcurrency)
          setChildTaskBudgetCapacity(next.maxActiveChildTasks)
        },
      }),
    }),
    maintenance: Object.freeze({
      configPath: input.configPath,
      maintenanceStatus: input.maintenanceStatus,
      databaseTelemetry: input.provider.telemetry,
    }),
    daemon: Object.freeze({ daemonInfoPath: input.daemonInfoPath }),
    plantuml: Object.freeze({ configPath: input.configPath }),
    runtime: Object.freeze({ configPath: input.configPath, runtimeRegistry: core.runtimeRegistry }),
    runtimes: Object.freeze({
      configPath: input.configPath,
      runtimeRegistry: core.runtimeRegistry,
      runtimeTests: mcpRuntimeTests,
    }),
    overview: Object.freeze({
      authorization: Object.freeze({ directAuthority: identityAccess.directAuthority }),
      query: overviewQuery,
    }),
  })

  const resourceCatalogRoutes: PostgresqlAppCompositionInput['resourceCatalog'] = Object.freeze({
    agents: Object.freeze({
      ...classicCatalogs.agent,
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
      runtimeTests: mcpRuntimeTests,
    }),
    plugins: Object.freeze({
      queries: pluginCatalog.queries,
      operations: pluginCatalog.operations,
      authorityFor,
    }),
    skills: Object.freeze({ ...classicCatalogs.skill, authorityFor }),
    repositories: Object.freeze({
      store: core.repositoryWorkspaceStore,
      cached: Object.freeze({
        configPath: input.configPath,
        appHome: input.appHome,
        secretBox: input.secretBox,
      }),
      groups: Object.freeze({ configPath: input.configPath }),
    }),
    workflows: Object.freeze({
      runtime: Object.freeze({}),
      module: Object.freeze({ ...classicCatalogs.workflow, authorityFor }),
    }),
    workgroups: Object.freeze({
      queries: workgroupCatalog.queries,
      operations: workgroupCatalog.operations,
      resourceIntegrityQueries: classicCatalogs.agentResourceIntegrity.queries,
      authorityFor,
      taskLaunch: taskExecutionProvider.routeLaunch.workgroup,
    }),
    resourcePackages: Object.freeze({
      catalog: resourcePackageCatalog,
      commandContextFor(actor: Actor) {
        const authority = directRequestAuthority(identityAccess.directAuthority, actor)
        const context = identityAccess.contexts.fromAuthority(authority, 'http')
        packageActors.set(context.authority, actor)
        return context
      },
      queryContextFor(actor: Actor) {
        return identityAccess.contexts.queryFromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actor),
          'http',
        )
      },
    }),
    workgroupTasks: Object.freeze({ module: workgroupTaskRoom, authorityFor }),
  })

  const taskExecutionRoutes: PostgresqlAppCompositionInput['taskExecution'] = Object.freeze({
    tasks: taskRoutes,
    catalog: taskCatalog,
    archive: Object.freeze({
      configPath: input.configPath,
      taskArchiveMaintenance: taskExecutionProvider.archive,
    }),
    portArtifacts: Object.freeze({
      taskExecutionReadModels: taskExecutionProvider.readModels,
    }),
    clarifyDirective: Object.freeze({
      operations: taskExecutionProvider.routes.clarifyDirective,
    }),
    feedback: Object.freeze({
      collaborationContext: boundCollaborationContext,
      memoryOperations,
    }),
  })

  const sourceControlRoutes: PostgresqlAppCompositionInput['sourceControl'] = Object.freeze({
    codeHosts: Object.freeze({ deps: Object.freeze({}), service: codeHostConnections }),
    repositoryTransportCredentials: Object.freeze({
      runtime: Object.freeze({}),
      route: Object.freeze({
        credentials: repositoryTransport.ownCredentials,
        currentSubjects: identityAccess.resolveAuthority,
      }),
    }),
    worktreeFiles,
  })

  const codeRoutes: PostgresqlAppCompositionInput['code'] = Object.freeze({
    history: codeHistoryQueries,
    capabilityTemplates: Object.freeze({
      codeHistoryQueries,
      capabilityTemplates: capabilityTemplateOperations,
      capabilityTemplateAcl,
    }),
  })

  const collaborationRoutes: PostgresqlAppCompositionInput['collaboration'] = Object.freeze({
    operations: collaborationRouteOperations,
    appHome: input.appHome,
  })

  const memoryRoutes: PostgresqlAppCompositionInput['memory'] = Object.freeze({
    fusion: Object.freeze({
      operations: fusionOperations,
      configPath: input.configPath,
      directAuthority: identityAccess.directAuthority,
    }),
    // RFC-353 T9：技能来源追溯——版本流水来自 resource-catalog，融合记录来自 memory，
    // 拼装归 knowledge-evolution，所以路由挂在 KE 的 inbound 上。
    skillProvenance: Object.freeze({
      skills: classicCatalogs.skill.queries,
      versions: classicCatalogs.skill.versionQueries,
      authorityFor: (actor: Actor) =>
        directOperationAuthority(identityAccess.directAuthority, actor),
      memoryAuthorityFor: (actor: Actor) => ({
        actor,
        authority: directRequestAuthority(identityAccess.directAuthority, actor),
      }),
      listFusedInto: (skillId: string) => memoryCatalog.queries.listFusedInto(skillId),
      filterVisibleMemories: (
        authority: MemoryScopeAuthority,
        rows: readonly FusedIntoSkillMemory[],
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

  const identityRoutes: PostgresqlAppCompositionInput['identity'] = Object.freeze({
    auth: Object.freeze({
      deps: Object.freeze({ configPath: input.configPath }),
      identityAccess,
      bindings: Object.freeze({
        auth: core.authRuntime,
        listIdentitiesForUser: (userId: string) => oidcIdentities.listIdentitiesForUser(userId),
        listTokenAuditForUser: (userId: string) => core.tokenCallAudit.listForUser(userId),
      }),
    }),
    oidcAuth: Object.freeze({
      deps: Object.freeze({ configPath: input.configPath }),
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

  const systemRoutes: PostgresqlAppCompositionInput['system'] = Object.freeze({
    maintenanceDisk: core.maintenanceDisk,
    backup: Object.freeze({ operations: core.systemOperations, identityAccess }),
    restore: Object.freeze({ operations: core.systemOperations, identityAccess }),
    databaseMigration: Object.freeze({
      operations: input.databaseMigration.operations,
      identityAccess,
    }),
  })

  realtimePolicy.bind({
    resourceVisibility: resourceCatalog.authorization,
    memoryVisibility: {
      async canViewMemory(authority, actor, scope) {
        return await memoryCatalog.queries.canView({ authority, actor }, scope)
      },
    },
    repoImportOwnerUserId: batchOwnerUserId,
    redactTaskEventPayload: redactEventPayload,
  })

  const composition: PostgresqlAppCompositionInput = Object.freeze({
    token: input.token,
    configPath: input.configPath,
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
  })
  // RFC-359 W3-T4（P0-3 / P0-4）：boot 恢复四步与 SQLite 同一段序列（composition/bootRecovery.ts）——
  // 撤销旧 daemon 的 owner → 收割孤儿 run → 修 runtime session lease → 清算 effect 并释放 / 闭合 owner。
  // 必须在 HTTP 与任何自动续跑之前；此前 PG daemon 从未跑过，重启一次就把上一代任务永久卡在 running。
  await runTaskExecutionBootRecovery({
    persistence: taskExecutionPersistence,
    runtimeSessionLeases: createRuntimeSessionLeaseOperations(input.db),
    lockProof: createDaemonLockProof({
      lockPath: input.lockPath,
      lockPid: process.pid,
      daemonGeneration: input.provider.runtime.generationId,
    }),
    codeHostProbe: (descriptor) =>
      probeCodeHostMutation({
        descriptor,
        resolveConnection: (provider) => codeHostConnections.resolve(provider),
      }),
    log,
  })
  // RFC-328 / RFC-359 W1-T7c：终态维护认领是持久的、比任务行活得久——崩溃留下的 delete 认领要在
  // 任何自动续跑打开之前续做完（成员任务在此之前一直被占位）。一份 provider 中立实现，与
  // cli/start.ts 同一段；其余三步 boot 恢复（owner / archive / workspace-gc）随 W3 统一启动序列接入。
  try {
    const deleteRecovery = await recoverInterruptedTaskDeletes(input.db)
    if (
      deleteRecovery.completed.length > 0 ||
      deleteRecovery.cleanupPending.length > 0 ||
      deleteRecovery.recoveryRequired.length > 0
    ) {
      log.info('terminal task delete recovery', { ...deleteRecovery })
    }
  } catch (err) {
    log.warn('terminal task delete recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-359 W3-T15-B：终态维护恢复的 archive / workspace-gc / webhook prune / legacy pruned 四步，
  // 与 cli/start.ts 同一段命令面。
  try {
    const archiveRecovery = await taskExecutionProvider.archive.recover({
      archiveDir: Paths.taskArchiveDir,
      runsDir: Paths.runsDir,
      logsDir: Paths.logsDir,
    })
    if (archiveRecovery.promoted.length > 0 || archiveRecovery.discarded.length > 0) {
      log.info('terminal task archive recovery', { ...archiveRecovery })
    }
  } catch (err) {
    log.warn('terminal task archive recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    const workspaceRecovery = await workspaceMaintenance.recover({
      activeTaskIds: [],
      webhookClaims: 'all',
    })
    if (
      workspaceRecovery.completed > 0 ||
      workspaceRecovery.failed > 0 ||
      workspaceRecovery.healed > 0
    ) {
      log.info('terminal workspace maintenance recovery', { ...workspaceRecovery })
    }
  } catch (err) {
    log.warn('terminal workspace maintenance recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-359 W3-T15：以下 boot 步骤与 cli/start.ts 同序、同一份实现；此前 PG daemon 一步都没跑
  //（终态维护恢复里的 archive / workspace-gc / webhook prune / legacy pruned 四步仍是 SQLite 专属实现，归 T15-B）。
  // 5b5. RFC-165 §9：把存量 path-mode 定时启动载荷治愈成当前形状——幂等 + best-effort。
  try {
    const { healScheduledLaunchPayloads } = await import('@/services/scheduledTasks')
    const healed = await healScheduledLaunchPayloads(scheduledTaskRuntime.operations)
    if (healed.converted > 0 || healed.disabled > 0) {
      log.info('scheduled launch payloads healed', healed)
    }
  } catch (err) {
    log.warn('scheduled payload heal on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5b5. RFC-170 T6：恢复崩溃留下的融合 DECISION 半状态（多事务决定）——best-effort。
  try {
    const { recoverFusionDecisions } =
      await import('@/modules/knowledge-evolution/public/operations')
    const r = await recoverFusionDecisions(fusionOperations.persistence)
    if (r.rolledForward + r.rolledBack + r.rejectFailed > 0) {
      log.info('fusion decision recovery on boot', { ...r })
    }
  } catch (err) {
    log.warn('fusion decision recovery on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5e. RFC-101：内置 skill-fusion agent + workflow 幂等播种。
  try {
    const { seedFusionResources } = await import('@/modules/knowledge-evolution/public/operations')
    await seedFusionResources(fusionOperations.persistence)
  } catch (err) {
    log.warn('fusion resource seed on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-310：业务模板是平台资源，不是 schema 数据；DB 准入后播种。
  await ensureDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates)

  // 5e-bis. RFC-307：示例内容，每次安装只提供一次（marker 门控）；从不致命。
  try {
    const { seedDemoContent } = await import('@/services/demoSeed')
    const result = await seedDemoContent({
      resourceCatalog: composePostgresqlDemoResourceCatalogSeedParticipant(input.db),
      codeCapability: composePostgresqlCodeCapabilityDemoSeedParticipant(input.db),
    })
    if (result.seeded) log.info('demo content seeded (delete it and it stays deleted)')
  } catch (err) {
    log.warn('demo content seed on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5f（runtime 注册表 boot）不在这里：PG 路径由 cli/start.ts 的 composePostgresqlProviderSession
  // 在 provider 会话建立时跑过一次（rfc359-w3-t15 锁住「恰好一次」）。

  // RFC-101 / RFC-359 T7d：HTTP 起来之前把版本快照与 live files 对齐（best-effort）。
  try {
    await skillCatalogBoot.reconcileLiveFiles()
  } catch (err) {
    log.warn('skill-version reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const app = createComposedApp(composePostgresqlAppDeps(composition))
  // RFC-170 T4a / RFC-359 T7d：后台回填遗留 v1 快照并逐技能 reverify，放行可用性闸。
  void (async () => {
    try {
      const bf = await skillCatalogBoot.backfillLegacyVersions()
      const r = await skillCatalogBoot.reverifySnapshots()
      log.info('boot snapshot reverify', {
        ...r,
        legacyBackfilled: bf.backfilled,
        husksRemoved: bf.husksRemoved,
      })
    } catch (err) {
      log.warn('boot snapshot reverify failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
  const webSocket = buildWebSocketAdapter({
    daemonToken: input.token,
    realtime: core.realtime,
    identityAccess: core.identityAccess,
  })
  const runtime: PostgresqlDaemonApplicationRuntime = Object.freeze({
    taskExecution: taskExecutionProvider,
    scheduledTasks: scheduledTaskRuntime,
    scheduledTaskIdentityAccess: integrationIdentityAccess,
    memory: memoryOperations,
    developmentAutomation,
    digitalEmployee,
    eventCenter,
    fusion: fusionOperations,
    resourceLimits: resourceLimitOperations,
    taskIdleTimeout: taskIdleTimeoutOperations,
    mcpRuntimeTests,
    webhookTerminalControl,
    workspaceMaintenance,
    intentMaintenance,
    resourcePackageActivity: resourcePackageAtomicApply,
    async resumeIntentSessions(sessionIds: readonly string[]) {
      if (sessionIds.length === 0) return
      await resumeQueuedIntentWorkingSets(
        { ...intentDispatchDeps, configSnapshot: loadConfig(input.configPath) },
        sessionIds,
      )
    },
    async driveHumanGateContinuation(input: {
      readonly taskId: string
      readonly continuationRef: string
    }) {
      const { taskId, continuationRef } = input
      await taskDriveCoordinator.submit({
        taskId,
        intentId: continuationRef,
        completionMode: 'background',
      })
    },
  })
  return Object.freeze({ core, app, webSocket, runtime })
}
