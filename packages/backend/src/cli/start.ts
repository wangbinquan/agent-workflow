// `agent-workflow start` — daemon foreground entry.

import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { createSecretBox } from '@/auth/secretBox'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import { ensureTokenFile } from '@/auth/token'
import { loadConfig } from '@/config'
import { createWebhookDispatcher } from '@/services/webhook/webhookDispatch'
import {
  composeSqliteWebhookDispatchCore,
  createSqliteWebhookExecutionRuntime,
} from '@/modules/integration/composition/webhookDispatch'
import { recoverInterruptedDeliveries } from '@/services/webhook/deliveryStore'
import {
  composeDevelopmentAutomation,
  composeSqliteDevelopmentAdmissionLookup,
  createSqliteDevelopmentDeliveryProvider,
  createSqliteDevelopmentMissionExecutionTerminalObserver,
  createSqliteMissionCodeHostEventContinuation,
} from '@/modules/development-automation/composition'
import { composeSqliteRequirementSourceRunner } from '@/modules/integration/composition/requirementSource'
import { composeSqlitePipelineEvidenceRunner } from '@/modules/integration/composition/pipelineEvidence'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  cleanupOrphanedGitCredentialLeases,
  composeRepositoryTransportCredentials,
  createRepositoryPublicationTransport,
  reconcileRepositoryTransportConnectionProjections,
} from '@/modules/source-control/composition'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { composeSqliteAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { composeSqliteDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import {
  composeSqliteTaskExecutionProviderRuntime,
  type SelectedSqliteTaskExecutionProviderRuntime,
  type TaskExecutionBackgroundControl,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import { createSqliteRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'
import { createSqliteTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots'
import {
  composeSqliteMemoryOperations,
  composeSqliteMemoryInjectionQueries,
} from '@/modules/memory/composition'
import { composeSqliteIntentMaintenanceSnapshotQueries } from '@/modules/intent/composition/maintenance'
import { composeSqliteApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeSqliteDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { sha256Hex } from '@/util/hash'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentWorkspaceRepositoryPreparation,
  buildDevelopmentMrFactsDeps,
  buildDevelopmentPipelineDeps,
  createDevelopmentWorkspaceRepositoryPreparation,
  resolveDevelopmentRepoBinding,
} from '@/services/developmentDeliveryDeps'
import { DbSchemaDriftError, formatSchemaDifference } from '@/db/schemaAdmission'
import { IS_EMBEDDED } from '@/embed'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { composeSqliteAppDeps, composeSqliteDaemonProviderCore, createComposedApp } from '@/server'
import { reconcileRunningFusions } from '@/services/fusion'
import { composeLegacySqliteResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import {
  resumeQueuedIntentWorkingSets,
  type IntentDispatchDeps,
} from '@/services/intent/dispatcher'
import { reapOrphanRuns } from '@/services/orphans'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import {
  createExclusiveDaemonLockProof,
  finalizeTaskExecutionRecovery,
  prepareTaskExecutionRecovery,
} from '@/services/taskExecutionParticipants'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import {
  composeHumanGateContinuationDriver,
  activeTaskIdsSnapshot,
  isTaskActive,
  retryRepositoryPreparation,
  shutdownActiveTaskExecutions,
} from '@/services/task'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { recoverInterruptedArchives } from '@/services/taskArchive'
import {
  composeTaskIdleTimeoutOperations,
  createSqliteTaskIdleTimeoutPersistence,
  runTaskIdleTimeoutSweep,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import { recoverInterruptedTaskDeletes } from '@/services/taskDelete'
import { startSubmoduleRefreshLoop } from '@/services/submoduleRefresh'
import {
  finishClaimedWebhookWorkspacePrune,
  recoverInterruptedWorkspaceGc,
  runClaimedWebhookWorkspacePrunes,
} from '@/services/gc'
import { startBackupScheduler, maybePreMigrationBackup } from '@/services/backupScheduler'
import { applyPendingRestoreIfAny } from '@/services/pendingRestore'
import { composeSqlitePostRestoreRecovery } from '@/modules/system-operations/composition'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { composeSqliteWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { startBatchImportGc } from '@/services/repoBatchImport'
import { activeResourceBundleApplyIds } from '@/services/bundle/apply'
import { getMcpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { admitDaemonIdentity } from '@/auth/session'
import { composeSqliteMcpRuntimeTestProvider } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composeAgentCatalog } from '@/modules/resource-catalog/composition/agentOperations'
import { composeMcpCatalog } from '@/modules/resource-catalog/composition/mcpOperations'
import { composePluginCatalog } from '@/modules/resource-catalog/composition/pluginOperations'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import { composeWorkflowCatalog } from '@/modules/resource-catalog/composition/workflowOperations'
import { composeWorkgroupCatalog } from '@/modules/resource-catalog/composition/workgroupOperations'
import { composeSqliteAgentImportQueries } from '@/modules/resource-catalog/composition/agentImportQueries'
import { composeSqliteMcpProbeStore } from '@/modules/resource-catalog/composition/mcpProbeStore'
import type { McpCatalogModule } from '@/modules/resource-catalog/public/operations'
import { getProbeByMcpId } from '@/services/mcpProbeStore'
import { mcpRouteNow } from '@/routes/mcps'
import { mcpOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { pluginOperationCoordinator } from '@/services/resourceOperationCoordinator'
import {
  deletePreparedMcpRuntimeTestsInTx,
  transitionMcpRuntimeTestsInTx,
} from '@/services/mcpRuntimeTestTransitions'
import { detectGitCapabilities, mergeTreeGateError, MIN_GIT_VERSION } from '@/services/gitVersion'
import { setMemoryDistillLangProvider } from '@/services/memoryDistillScheduler'
import { acquireLock, adoptCurrentProcessLock, DaemonLockHeldError, type Lock } from '@/util/lock'
import {
  PRESENCE_CHANNEL,
  presenceBroadcaster,
  tasksListBroadcaster,
  TASKS_LIST_CHANNEL,
} from '@/ws/broadcaster'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { getRuntimeDriver } from '@/services/runtime'
import { Paths } from '@/util/paths'
import { readControlFile, requestShutdown, startControlListener } from '@/services/controlListener'
import { buildWebSocketAdapter } from '@/ws/server'
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { startMaintenanceService } from '@/platform/background/maintenanceService'
import { composeMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'
import {
  canViewResourceInTx,
  composeResourceScopeAuthorizationBinding,
} from '@/modules/resource-catalog/composition/resourceAcl'
import { composeIntegrationTriggerResourceBinding } from '@/modules/resource-catalog/composition/integrationTrigger'
import { composeSqliteDynamicWorkflowValidationContext } from '@/modules/resource-catalog/composition/workflowOperations'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { composeSqliteAgentResourceIntegrity } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { composeEventCenter, runEventCenterCycle } from '@/modules/event-center/composition'
import {
  composeSqliteDigitalEmployeeWriterCutover,
  composeDigitalEmployeeAgentTemplateCatalogParticipant,
  composeDigitalEmployee,
  composeDigitalEmployeeIntegrationTriggerParticipant,
  createEmployeeInputArtifactStore,
  createReactionExecutionAdapter,
  readPersistedDigitalEmployeeTypePackageDescriptorJsons,
  runDigitalEmployeeOsCycle,
} from '@/modules/digital-employee/composition'
import { assertNotBuiltin } from '@/services/systemResources'
import { legacyTaskExecutionResourceDependencies } from '@/services/execution/legacyTaskExecutionResourceDependencies'
import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import {
  developmentExecutionContractRegistrations,
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { composeSqliteCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composeSqliteCapabilityTemplateOperations } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { composeSqliteCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { composeSqliteDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composeSqliteFusionOperations } from '@/modules/memory/composition/fusion'
import {
  composeSqliteDevelopmentEmployeeWorkspace,
  createSqliteDevelopmentEmployeeCaseWorkspaceDetailReader,
} from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeSqliteDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeCaseDetailProjection } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import {
  composeDevelopmentApprovalEventObserver,
  composeDevelopmentCodeHostEventObserver,
  composeDevelopmentEmployeeEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import {
  createCodeHostWebhookDeliveryConsumer,
  createCodeHostWebhookRoutingDirectory,
  createRepositoryEndpointDiscovery,
} from '@/modules/integration/composition'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { composeDigitalEmployeeExecution } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'
import { collaborationCommittedEventCatalogJson } from '@/modules/collaboration/public/events'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  createSqliteTaskLifecycleWsProjector,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/composition/committedEvents'
import {
  combineCommittedEventCodecRegistries,
  createCommittedEventDispatcher,
} from '@/platform/events/committed/dispatcherWorker'
import {
  createCollaborationDurableConsumerDefinitions,
  createCollaborationWsProjector,
  createSqliteCollaborationCommittedEventProjection,
  collaborationCommittedEventCodec,
  createHumanGateContinuationWorkerDefinition,
} from '@/modules/collaboration/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { createSqliteCommittedEventDeliveryPersistence } from '@/platform/events/committed/sqlitePersistence'
import { createCommittedEventProjectionLedger } from '@/platform/events/committed/types'
import {
  createCommittedEventDispatcherWorkerDefinition,
  startManagedWorkerDefinition,
} from '@/platform/events/committed/workerDefinitions'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { notifyChildBudgetTaskStatus } from '@/services/execution/childBudget'
import { notifyTaskTerminal } from '@/services/execution/executionWatch'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { createDeferredDigitalEmployeeWorkStart } from '@/modules/integration/composition'
import { createCodeHostConnectionsService } from '@/services/codeHost/connections'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { readDatabaseGeneration } from '@/platform/persistence/generationStore'
import { createDaemonRealtimePolicyBinding } from './daemonRealtimePolicy'
import { composeSqliteResourceCatalog } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeSqliteSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import type { SkillCatalogBootParticipant } from '@/modules/resource-catalog/public/participants'
import { composeSqliteWebhookDeliveryPersistence } from '@/modules/integration/composition/webhookDelivery'
import {
  createCollaborationCommandContext,
  createSqliteHumanGateContinuationRecoveryQueries,
  createSqliteHumanGateTerminalSweepCommand,
} from '@/modules/collaboration/composition'
import {
  createSqliteClarifyDecisionCommand,
  createSqliteQuestionDispatchCommand,
  createSqliteReviewDecisionCommand,
} from '@/modules/collaboration/composition/legacySqliteDecisionCommands'
import { createSqliteCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/sqliteCollaborationRuntimeMechanics'
import { composeSqliteScheduledTaskRuntime } from '@/modules/integration/composition/scheduledTasks'
import { assertWorkflowSnapshotLaunchable } from '@/services/taskLaunchGate'
import { readCommittedReviewArtifactBody } from '@/modules/collaboration/public/queries'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { directOperationAuthority, directRequestAuthority } from '@/routes/operationAuthority'
import type { Actor } from '@/auth/actor'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import { composeIntentResourceCatalogFor } from '@/services/intent/resourceCatalog'
import { composeSqliteIntentPersistence } from '@/modules/intent/composition/persistence'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '@/modules/resource-catalog/composition/intentContextAuthorization'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '@/modules/intent/composition/auxiliaryQueries'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import { composeDigitalEmployeePlatformInventoryParticipant } from '@/modules/digital-employee/composition'
import {
  composeDevelopmentConfigOperations,
  type DevelopmentConfigResourceAccess,
} from '@/modules/development-automation/composition/configOperations'
import { composeDevelopmentAdapterConfigOperations } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { createDatabaseMigrationDaemonAdmission } from '@/modules/system-operations/composition'
import {
  createDaemonProviderBootstrap,
  type DaemonProviderBootstrap,
} from './daemonProviderBootstrap'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderCloseParticipant,
  type DaemonProviderRuntimeAdmission,
  type DaemonProviderRuntimeHandleFactory,
} from './daemonProviderRuntimeSession'
import { describeDaemonProviderSessionFailure } from './daemonProviderSession'
import {
  createLazyPausableDaemonRuntimeServiceBindings,
  createManagedWorkerRuntimeHandleFactory,
  createPausableDaemonRuntimeServiceBindings,
  createPollingDaemonRuntimeHandleFactory,
} from './daemonProviderRuntimeHandles'
import {
  composePostgresqlDaemonApplication,
  type PostgresqlDaemonApplication,
  type PostgresqlDaemonApplicationInput,
} from './postgresqlDaemonApplication'
import { createPostgresqlMaintenanceRunStore } from '@/platform/persistence/postgresqlMaintenanceRunStore'
import { createPostgresqlCommittedEventDeliveryPersistence } from '@/platform/events/committed/postgresqlPersistence'
import {
  createPostgresqlCollaborationCommittedEventProjection,
  createPostgresqlHumanGateContinuationRecoveryQueries,
  createPostgresqlHumanGateTerminalSweepCommand,
} from '@/modules/collaboration/composition'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { enforceLimits } from '@/services/limits'
import { initializeRuntimeRegistryBoot } from '@/platform/runtime-registry/composition'

export interface StartOptions {
  port?: number
  host?: string
}

interface DaemonProviderHttpAdmission {
  readonly lifecycle: Pick<
    DaemonProviderRuntimeAdmission,
    'closeWriterAdmission' | 'openWriterAdmission'
  >
  readonly run: (request: Request, next: () => Promise<Response>) => Promise<Response>
}

function isProviderControlRequest(request: Request): boolean {
  const path = new URL(request.url).pathname
  return (
    path === '/api/database' ||
    path.startsWith('/api/database/') ||
    path === '/api/health' ||
    // The endpoint an operator (and the RFC-349 evidence run) watches a
    // migration through. It reads an in-memory maintenance projection plus
    // in-memory pool telemetry — no database work of its own — so refusing it
    // only blinds the caller during the exact window it exists to describe.
    path === '/api/maintenance/status' ||
    (!path.startsWith('/api/') && !path.startsWith('/ws/'))
  )
}

/**
 * Provider-session HTTP fence. It is deliberately independent from the
 * migration state machine: the runtime session closes this gate before it
 * drains background writers and opens it only after every selected-provider
 * handle has started. Migration-control and health routes remain reachable so
 * a failed switch can report/recover without reopening business traffic.
 */
function createDaemonProviderHttpAdmission(): DaemonProviderHttpAdmission {
  let open = false
  return Object.freeze({
    lifecycle: Object.freeze({
      closeWriterAdmission() {
        open = false
      },
      openWriterAdmission() {
        open = true
      },
    }),
    async run(request: Request, next: () => Promise<Response>) {
      if (open || isProviderControlRequest(request)) return await next()
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'database-maintenance',
          message: 'database provider runtime is not accepting business requests',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
}

interface DaemonProviderRuntimeComposition {
  readonly provider: 'sqlite' | 'postgresql'
  readonly generationId: string
  readonly app: Pick<ReturnType<typeof createComposedApp>, 'fetch'>
  readonly webSocket: ReturnType<typeof buildWebSocketAdapter>
  readonly runtimeFactories?: readonly DaemonProviderRuntimeHandleFactory[]
  readonly backgroundWriterFactories?: readonly DaemonProviderRuntimeHandleFactory[]
  readonly providerCloseParticipants?: readonly DaemonProviderCloseParticipant[]
  readonly shutdownIdentity: () => void | Promise<void>
  readonly closeProvider: () => void | Promise<void>
}

type DatabaseMigrationAdmission = Parameters<typeof composeDatabaseMigrationModule>[0]['admission']

/** The bootstrap face this holder needs: the module port plus the live phase. */
interface BoundDatabaseMigrationBootstrap {
  readonly databaseMigration: DatabaseMigrationAdmission
  readonly live: () => { readonly phase: string }
}

interface DeferredDatabaseMigrationAdmission {
  readonly admission: DatabaseMigrationAdmission
  /**
   * RFC-349 T10 — the request path's own writes (session/PAT last-used, token
   * call audit) must stop while a migration has frozen the source. They run in
   * authentication, before the route gate, and on the deliberately exempt
   * `/api/database/*` path, so nothing else can see them.
   */
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly bind: (bootstrap: BoundDatabaseMigrationBootstrap) => void
}

interface DeferredSchedulerDriver {
  readonly driver: SchedulerDriverPort
  readonly bind: (driver: SchedulerDriverPort) => void
}

/** Bootstrap-local cycle breaker for the one TaskExecution composition. */
function createDeferredSchedulerDriver(): DeferredSchedulerDriver {
  let bound: SchedulerDriverPort | null = null
  const requireBound = (): SchedulerDriverPort => {
    if (bound === null) throw new Error('task-execution-scheduler-not-bound')
    return bound
  }
  return Object.freeze({
    driver: Object.freeze({
      drive: (request: Parameters<SchedulerDriverPort['drive']>[0]) =>
        requireBound().drive(request),
      cancelChild: (input: Parameters<SchedulerDriverPort['cancelChild']>[0]) =>
        requireBound().cancelChild(input),
      resumeChild: (input: Parameters<SchedulerDriverPort['resumeChild']>[0]) =>
        requireBound().resumeChild(input),
      isTaskActive: (taskId: Parameters<SchedulerDriverPort['isTaskActive']>[0]) =>
        requireBound().isTaskActive(taskId),
    }),
    bind(driver: SchedulerDriverPort) {
      if (bound !== null && bound !== driver) {
        throw new Error('task-execution-scheduler-already-bound')
      }
      bound = driver
    },
  })
}

function _bindTaskExecutionProviderBackground(
  background: TaskExecutionBackgroundControl,
  dependencies: TaskExecutionBackgroundStartDependencies,
) {
  return createLazyPausableDaemonRuntimeServiceBindings({
    runtimeId: 'task-execution',
    closeParticipantId: 'task-execution-final-close',
    service: background,
    start: () => background.start(dependencies),
  })
}

/**
 * Break the intentional app/bootstrap cycle without exposing an ambient
 * registry. Migration routes are composed before the provider controller, but
 * remain fail-closed until this exact daemon binds its controller-owned port.
 */
function _createDeferredDatabaseMigrationAdmission(): DeferredDatabaseMigrationAdmission {
  let bound: BoundDatabaseMigrationBootstrap | null = null
  const requireBound = (): DatabaseMigrationAdmission => {
    if (bound === null) throw new Error('database-migration-admission-not-bound')
    return bound.databaseMigration
  }
  return Object.freeze({
    admission: Object.freeze({
      freezeAndDrain: (input: Parameters<DatabaseMigrationAdmission['freezeAndDrain']>[0]) =>
        requireBound().freezeAndDrain(input),
      reopenSqlite: (input: Parameters<DatabaseMigrationAdmission['reopenSqlite']>[0]) =>
        requireBound().reopenSqlite(input),
      activatePostgresql: (
        input: Parameters<DatabaseMigrationAdmission['activatePostgresql']>[0],
      ) => requireBound().activatePostgresql(input),
      openPostgresqlAdmission: (
        input: Parameters<DatabaseMigrationAdmission['openPostgresqlAdmission']>[0],
      ) => requireBound().openPostgresqlAdmission(input),
    }),
    // Before bootstrap binds there is no operation and therefore no freeze, so
    // "writable" is the honest answer rather than a fail-closed guess.
    sourceWriteWindow: Object.freeze({
      writable: () => bound === null || bound.live().phase === 'open',
    }),
    bind(bootstrap: BoundDatabaseMigrationBootstrap) {
      if (bound !== null && bound !== bootstrap) {
        throw new Error('database-migration-admission-already-bound')
      }
      bound = bootstrap
    },
  })
}

/** Join one provider's already-composed application and background lifetimes. */
async function _createComposedDaemonProviderRuntimeSession(
  input: DaemonProviderRuntimeComposition,
) {
  const httpAdmission = createDaemonProviderHttpAdmission()
  return await createDaemonProviderRuntimeSession({
    provider: input.provider,
    generationId: input.generationId,
    runtime: Object.freeze({
      fetch: (request: Request) =>
        httpAdmission.run(request, async () => await input.app.fetch(request)),
      tryUpgrade: input.webSocket.tryUpgrade,
      websocketHandlers: input.webSocket.handlers,
    }),
    admission: Object.freeze({
      ...httpAdmission.lifecycle,
      closeWebSocketAdmission: input.webSocket.admission.close,
      openWebSocketAdmission: input.webSocket.admission.open,
    }),
    ...(input.runtimeFactories === undefined ? {} : { runtimeFactories: input.runtimeFactories }),
    ...(input.backgroundWriterFactories === undefined
      ? {}
      : { backgroundWriterFactories: input.backgroundWriterFactories }),
    ...(input.providerCloseParticipants === undefined
      ? {}
      : { providerCloseParticipants: input.providerCloseParticipants }),
    shutdownIdentity: input.shutdownIdentity,
    closeProvider: input.closeProvider,
  })
}

type PostgresqlProviderRuntime = Extract<
  ReturnType<typeof resolveDatabaseProviderRuntime>,
  { readonly provider: 'postgresql' }
>

interface ComposedPostgresqlProviderSession {
  readonly application: PostgresqlDaemonApplication
  readonly session: Awaited<ReturnType<typeof _createComposedDaemonProviderRuntimeSession>>
}

function requirePostgresqlConfig(
  config: ReturnType<typeof loadConfig>,
): PostgresqlDaemonApplicationInput['config'] {
  if (config.database.provider !== 'postgresql') {
    throw new Error('postgresql-daemon-config-provider-mismatch')
  }
  return Object.freeze({ ...config, database: config.database })
}

/**
 * Compose one complete frozen PostgreSQL daemon session. The selected client
 * is captured by owner factories once; HTTP, WS, workers and maintenance all
 * use the same aggregate and are stopped before the provider pool closes.
 */
async function composePostgresqlProviderSession(input: {
  readonly provider: PostgresqlProviderRuntime
  readonly config: PostgresqlDaemonApplicationInput['config']
  readonly token: string
  readonly secretBox: ReturnType<typeof createSecretBox>
  readonly dbVersion: number
  readonly migrationAdmission: DatabaseMigrationAdmission
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly log: ReturnType<typeof createLogger>
}): Promise<ComposedPostgresqlProviderSession> {
  if (input.config.database.provider !== 'postgresql') {
    throw new Error('postgresql-daemon-config-provider-mismatch')
  }
  const db = input.provider.openClient()
  const databaseMigration = composeDatabaseMigrationModule({
    admission: input.migrationAdmission,
    sqlitePath: Paths.db,
    operationsRoot: Paths.databaseMigrationsDir,
    generationPointerPath: Paths.databaseGenerationPointer,
    configPath: Paths.config,
    executionMode: 'background',
    onBackgroundFailure({ operationId, error }) {
      input.log.error('database migration background operation failed', {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  let boundMaintenanceStatus: ReturnType<typeof startMaintenanceService>['status'] | null = null
  const application = await composePostgresqlDaemonApplication({
    provider: input.provider,
    db,
    config: input.config,
    token: input.token,
    appHome: Paths.root,
    configPath: Paths.config,
    daemonInfoPath: Paths.daemonInfo,
    lockPath: Paths.lock,
    secretBox: input.secretBox,
    sourceWriteWindow: input.sourceWriteWindow,
    databaseMigration,
    dbVersion: input.dbVersion,
    maintenanceStatus() {
      if (boundMaintenanceStatus === null) {
        throw new Error('postgresql-maintenance-status-not-bound')
      }
      return boundMaintenanceStatus()
    },
  })
  await initializeRuntimeRegistryBoot({
    operations: application.core.runtimeRegistry,
    config: input.config,
    configPath: Paths.config,
    onRecoverableFailure(error) {
      input.log.warn('builtin runtime seed/migration on boot failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const runtime = application.runtime

  const maintenanceService = startMaintenanceService({
    provider: 'postgresql',
    generationId: input.provider.generation.payload.generationId,
    database: input.config.database,
    store: createPostgresqlMaintenanceRunStore(db),
    appHome: Paths.root,
    configPath: Paths.config,
    loadConfig: () => loadConfig(Paths.config),
    payloadSources: Object.freeze({
      activeTaskIds: activeTaskIdsSnapshot,
      activeIntentApplyJournalIds: runtime.intentMaintenance.activeApplyJournalIds,
      activeResourceBundleApplyIds: runtime.resourcePackageActivity.activeApplyIds,
      bootIntentTurnIds: runtime.intentMaintenance.bootTurnIds,
    }),
    onLifecycleDelta(delta) {
      for (const alert of delta.alerts) {
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'lifecycle.alert',
          taskId: alert.taskId,
          rule: alert.rule,
          severity: alert.severity,
          transition: alert.transition,
        })
      }
      for (const taskId of delta.resolvedTaskIds) {
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'lifecycle.alert.resolved',
          taskId,
        })
      }
    },
    onIntentQueued(sessionIds) {
      void runtime.resumeIntentSessions(sessionIds).catch((error) => {
        input.log.warn('queued PostgreSQL intent working-set admission failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
  })
  boundMaintenanceStatus = maintenanceService.status

  const maintenanceBindings = await createPausableDaemonRuntimeServiceBindings({
    runtimeId: 'maintenance',
    closeParticipantId: 'maintenance-final-close',
    service: maintenanceService,
  })
  const mcpRuntimeBindings = await createPausableDaemonRuntimeServiceBindings({
    runtimeId: 'mcp-runtime-tests',
    closeParticipantId: 'mcp-runtime-tests-final-close',
    service: runtime.mcpRuntimeTests,
  })
  const taskExecutionBindings = await _bindTaskExecutionProviderBackground(
    runtime.taskExecution.background,
    {
      configPath: Paths.config,
      scheduled: {
        operations: runtime.scheduledTasks.operations,
        identityAccess: runtime.scheduledTaskIdentityAccess,
        loadConfig: () => loadConfig(Paths.config),
      },
    },
  )

  const humanGateRecovery = createPostgresqlHumanGateContinuationRecoveryQueries(db)
  const humanGateWorker = createHumanGateContinuationWorkerDefinition({
    listPending: () => humanGateRecovery.listPending(),
    drive: runtime.driveHumanGateContinuation,
    onError(continuation) {
      input.log.warn('pending PostgreSQL human-gate continuation drive failed', {
        taskId: continuation.taskId,
        continuationRef: continuation.continuationRef,
        error:
          continuation.error instanceof Error
            ? continuation.error.message
            : String(continuation.error),
      })
    },
  })
  const humanGateRuntimeFactory = createManagedWorkerRuntimeHandleFactory({
    id: 'human-gate-continuation',
    stopReason: 'provider-session-paused',
    start() {
      return startManagedWorkerDefinition(humanGateWorker.definition, DAEMON_GENERATION)
    },
  })

  const committedEventCodecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  const committedEventProjectors = [
    runtime.taskExecution.lifecycleProjector,
    createCollaborationWsProjector(createPostgresqlCollaborationCommittedEventProjection(db)),
  ]
  const committedEventProjectionLedger = createCommittedEventProjectionLedger()
  const committedEventPersistence = createPostgresqlCommittedEventDeliveryPersistence(db)
  const terminalSweep = createPostgresqlHumanGateTerminalSweepCommand(db)
  const committedEventDispatcher = createCommittedEventDispatcher({
    persistence: committedEventPersistence,
    workerId: `committed-events-${DAEMON_GENERATION}`,
    codecs: committedEventCodecs,
    consumers: [
      ...createTaskLifecycleDurableConsumerDefinitions({
        events: runtime.eventCenter.commands,
        async closeTerminalGates(taskId, status) {
          await terminalSweep.run({ taskId, cause: `task-${status}` })
        },
        async notifyChildBudget(taskId, status) {
          notifyChildBudgetTaskStatus(runtime.taskExecution.persistence.childBudget, taskId, status)
        },
        async notifyExecutionWatch(taskId, status) {
          notifyTaskTerminal(taskId, status)
        },
        async nudgeWorkspacePrune(taskId) {
          if (isTaskActive(taskId)) return
          await runtime.workspaceMaintenance.finalizeClaimedWorkspace(taskId)
        },
      }),
      ...createCollaborationDurableConsumerDefinitions({
        events: runtime.eventCenter.commands,
        nudgeContinuation: humanGateWorker.nudge,
        async enqueueReviewDistill(request) {
          await runtime.memory.distillCommands.enqueue({
            sourceKind: 'review',
            sourceEventId: request.sourceEventId,
            taskId: request.taskId,
          })
        },
      }),
      ...committedEventProjectors,
    ],
    projectionLedger: committedEventProjectionLedger,
    maxAttempts() {
      const current = loadConfig(Paths.config)
      return 1 + current.defaultNodeRetries + current.sessionRestartBudget
    },
  })
  const committedEventWorker = createCommittedEventDispatcherWorkerDefinition({
    persistence: committedEventPersistence,
    dispatcher: committedEventDispatcher,
  })
  const committedEventRuntimeFactory = createManagedWorkerRuntimeHandleFactory({
    id: 'committed-event-dispatcher',
    stopReason: 'provider-session-paused',
    start() {
      return startManagedWorkerDefinition(committedEventWorker.definition, DAEMON_GENERATION)
    },
  })
  const committedEventPump = createAfterCommitEventPump({
    persistence: committedEventPersistence,
    codecs: committedEventCodecs,
    projectors: committedEventProjectors,
    projectionLedger: committedEventProjectionLedger,
    nudgeDispatcher: committedEventWorker.nudge,
  })
  const afterCommitPumpFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'after-commit-event-pump',
    start() {
      registerAfterCommitEventPump(committedEventPump)
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          registerAfterCommitEventPump(null)
        },
        drain() {
          if (!stopped) throw new Error('after-commit-event-pump-drain-before-stop')
        },
      })
    },
  })

  setMemoryDistillLangProvider(() => {
    try {
      return loadConfig(Paths.config).memoryDistillLang ?? null
    } catch {
      return null
    }
  })
  const memoryDistillRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'memory-distill',
    intervalMs: 1_000,
    beforeStart: () => runtime.memory.distillWorker.recoverRunning().then(() => undefined),
    async run() {
      const current = loadConfig(Paths.config)
      if (current.memoryDistillerEnabled === false) return
      await runtime.memory.distillWorker.tick({
        runtimeName: current.memoryDistillRuntime ?? null,
        defaultRuntime: current.defaultRuntime ?? null,
        model: current.memoryDistillModel ?? null,
        sourceContextBudget: current.memoryDistillSourceContext,
      })
    },
    onError(error) {
      input.log.warn('PostgreSQL memory distill tick failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const developmentWakeRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'development-wake',
    intervalMs: DAEMON_CADENCE.developmentWakeSweep,
    run: () => runtime.developmentAutomation.sweepWakes().then(() => undefined),
    onError(error) {
      input.log.warn('PostgreSQL development wake sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  if (runtime.digitalEmployee.runtime === null) {
    throw new Error('postgresql-digital-employee-runtime-not-composed')
  }
  const employeeRuntime = runtime.digitalEmployee.runtime
  const digitalEmployeeRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'digital-employee-os',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      const result = await runDigitalEmployeeOsCycle({ runtime: employeeRuntime.worker })
      if (result.steps >= 32) {
        input.log.warn('PostgreSQL digital employee OS reached its bounded step budget', {
          ...result,
        })
      }
    },
    onError(error) {
      input.log.warn('PostgreSQL digital employee OS cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const eventCenterRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'event-center',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      const result = await runEventCenterCycle(runtime.eventCenter.worker)
      if (result.steps >= 32) {
        input.log.warn('PostgreSQL event center reached its bounded step budget', { ...result })
      }
    },
    onError(error) {
      input.log.warn('PostgreSQL event center cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const fusionRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'fusion-reconcile',
    intervalMs: DAEMON_CADENCE.fusionReconcile,
    run: () => reconcileRunningFusions({ operations: runtime.fusion, appHome: Paths.root }),
    onError() {},
  })
  const limitsRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'resource-limits',
    intervalMs: DAEMON_CADENCE.resourceLimits,
    run: () => enforceLimits(runtime.resourceLimits).then(() => undefined),
    onError(error) {
      input.log.error('PostgreSQL resource limit enforcement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  // RFC-350 —— 不活跃超时收割（僵尸任务），DEFAULT OFF。见 SQLite 侧同名 handle 的说明。
  const idleTimeoutRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'task-idle-timeout',
    intervalMs: DAEMON_CADENCE.taskIdleTimeout,
    run: () =>
      runTaskIdleTimeoutSweep(
        runtime.taskIdleTimeout,
        loadConfig(Paths.config).taskIdleTimeout,
      ).then(() => undefined),
    onError(error) {
      input.log.error('PostgreSQL task idle-timeout sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  const backupRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'scheduled-backup',
    start() {
      const current = loadConfig(Paths.config)
      const ticker = startBackupScheduler({
        createScheduledBackup: () =>
          application.core.systemOperations.application.commands.requestBackup.execute(
            application.core.systemOperations.localContext,
            { includeWorktrees: true },
          ),
        intervalMs: current.backupIntervalMs,
        retentionCount: current.backupRetentionCount,
        retentionDays: current.backupRetentionDays,
        maxTotalBytes: current.backupMaxTotalBytes,
        protectedKeepCount: current.backupProtectedKeepCount,
        loadRetention: () => {
          const next = loadConfig(Paths.config)
          return {
            retentionCount: next.backupRetentionCount,
            retentionDays: next.backupRetentionDays,
            maxTotalBytes: next.backupMaxTotalBytes,
            protectedKeepCount: next.backupProtectedKeepCount,
          }
        },
        appHome: Paths.root,
        pruneMode: 'external',
        onBackupSettled: () => maintenanceService.runSoon('backupPrune'),
      })
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('scheduled-backup-drain-before-stop')
        },
      })
    },
  })
  const submoduleRefreshRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'submodule-refresh',
    start() {
      const ticker = startSubmoduleRefreshLoop(
        application.core.repositoryWorkspaceStore,
        () => loadConfig(Paths.config),
        undefined,
        Paths.root,
        input.secretBox,
      )
      const unregister = registerConfigAppliedListener(Paths.config, () => ticker.reconfigure())
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          unregister()
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('submodule-refresh-drain-before-stop')
        },
      })
    },
  })
  const batchImportRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'batch-import-gc',
    start() {
      const ticker = startBatchImportGc(
        undefined,
        loadConfig(Paths.config).repoBatchImportRetentionMs,
      )
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('batch-import-gc-drain-before-stop')
        },
      })
    },
  })

  const gracefulTaskShutdown: DaemonProviderCloseParticipant = Object.freeze({
    id: 'task-execution-graceful-shutdown',
    async close() {
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(
        {
          controller: { shutdownActive: shutdownActiveTaskExecutions },
          operations: runtime.taskExecution.shutdown,
          recovery: runtime.taskExecution.recovery,
        },
        30_000,
      )
    },
  })
  const webhookTerminalClose: DaemonProviderCloseParticipant = Object.freeze({
    id: 'webhook-terminal-control',
    close: () => runtime.webhookTerminalControl.stop(),
  })
  // RFC-349 — mirror of the SQLite bootstrap below: the terminal-control worker
  // holds an interval timer plus a fire-and-forget drain bound to this
  // generation's client, so a pause has to stop it, not just a close. The close
  // participant above still runs for the retired session; `stop` is idempotent.
  const webhookTerminalRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'webhook-terminal-control',
    start() {
      runtime.webhookTerminalControl.resume()
      let stopping: Promise<void> | null = null
      return Object.freeze({
        stop() {
          stopping ??= runtime.webhookTerminalControl.stop()
          return stopping
        },
        async drain() {
          if (stopping === null) throw new Error('webhook-terminal-control-drain-before-stop')
          await stopping
        },
      })
    },
  })

  const session = await _createComposedDaemonProviderRuntimeSession({
    provider: 'postgresql',
    generationId: input.provider.generation.payload.generationId,
    app: application.app,
    webSocket: application.webSocket,
    runtimeFactories: [
      taskExecutionBindings.runtimeFactory,
      maintenanceBindings.runtimeFactory,
      mcpRuntimeBindings.runtimeFactory,
    ],
    backgroundWriterFactories: [
      webhookTerminalRuntimeFactory,
      afterCommitPumpFactory,
      humanGateRuntimeFactory,
      committedEventRuntimeFactory,
      memoryDistillRuntimeFactory,
      developmentWakeRuntimeFactory,
      digitalEmployeeRuntimeFactory,
      eventCenterRuntimeFactory,
      fusionRuntimeFactory,
      limitsRuntimeFactory,
      idleTimeoutRuntimeFactory,
      backupRuntimeFactory,
      submoduleRefreshRuntimeFactory,
      batchImportRuntimeFactory,
    ],
    providerCloseParticipants: [
      taskExecutionBindings.closeParticipant,
      maintenanceBindings.closeParticipant,
      mcpRuntimeBindings.closeParticipant,
      gracefulTaskShutdown,
      webhookTerminalClose,
    ],
    shutdownIdentity: () => application.core.identityAccess.shutdown(),
    closeProvider: () => input.provider.close(),
  })
  return Object.freeze({ application, session })
}

async function servePostgresqlDaemon(input: {
  readonly bootstrap: DaemonProviderBootstrap
  readonly authRuntime: Pick<
    PostgresqlDaemonApplication['core']['authRuntime'],
    'isBootstrapRequired'
  >
  readonly token: string
  readonly bindHost: string
  readonly bindPort: number
  readonly lock: Lock
  readonly log: ReturnType<typeof createLogger>
}): Promise<never> {
  const server = Bun.serve({
    port: input.bindPort,
    hostname: input.bindHost,
    idleTimeout: 255,
    async fetch(request: Request, bunServer): Promise<Response> {
      return await input.bootstrap.runBusinessRequest(request, async () => {
        const upgraded = await input.bootstrap.tryUpgrade(request, bunServer)
        if (upgraded === true) return undefined as unknown as Response
        if (upgraded === false) return await input.bootstrap.fetch(request)
        return upgraded
      })
    },
    websocket: input.bootstrap.websocketHandlers,
  })
  const baseUrl = `http://${server.hostname}:${server.port}/`
  input.log.info('listening', { url: baseUrl, databaseProvider: 'postgresql' })

  const removeDaemonInfo = (): void => {
    try {
      unlinkSync(Paths.daemonInfo)
    } catch {
      // already removed or never written
    }
  }
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    input.log.info('shutting down', { signal, databaseProvider: 'postgresql' })
    removeDaemonInfo()
    server.stop(true)
    try {
      await input.bootstrap.stop()
    } catch (error) {
      input.log.warn('PostgreSQL daemon shutdown error', {
        error: describeDaemonProviderSessionFailure(error),
      })
    }
    controlListener.close()
    input.lock.release()
    process.exit(0)
  }
  const controlListener = startControlListener({
    controlFilePath: Paths.controlFile,
    devWatch: devLockHandoffMs() > 0,
    onShutdown: () => {
      removeDaemonInfo()
      void shutdown('control-shutdown')
    },
  })
  process.on('SIGTERM', () => {
    removeDaemonInfo()
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    removeDaemonInfo()
    void shutdown('SIGINT')
  })
  process.on('exit', () => {
    removeDaemonInfo()
    controlListener.close()
    input.lock.release()
  })

  writeFileSync(
    Paths.daemonInfo,
    JSON.stringify(
      {
        pid: input.lock.pid,
        host: server.hostname,
        port: server.port,
        url: baseUrl,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  const browserUrl = readyBrowserUrl(
    baseUrl,
    input.token,
    await input.authRuntime.isBootstrapRequired(),
  )
  process.stdout.write(
    `\nagent-workflow ready — open this URL in your browser:\n  ${browserUrl}\n\n`,
  )
  await new Promise<void>(() => {
    /* never resolves */
  })
  throw new Error('postgresql-daemon-listener-returned')
}

const MAX_DEV_LOCK_HANDOFF_MS = 60_000

function devLockHandoffMs(): number {
  const raw = process.env.AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS
  if (raw === undefined) return 0
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0
  return Math.min(parsed, MAX_DEV_LOCK_HANDOFF_MS)
}

/**
 * Bun --watch keeps the old generation alive until its replacement is ready.
 * A daemon cannot become ready while the old generation owns the PID lock, so
 * waiting alone deadlocks. Dev daemons advertise handoff eligibility in their
 * authenticated loopback control file; the replacement asks that exact PID to
 * drain, then waits for its lock. Normal `start` daemons never opt in and retain
 * the fail-fast singleton contract.
 */
async function acquireStartLock(
  lockPath: string,
  onWait: (owner: DaemonLockHeldError, maxWaitMs: number) => void,
  onShutdownRequested: (owner: DaemonLockHeldError) => void,
  onSameProcessAdopted: (owner: DaemonLockHeldError) => void,
): Promise<Lock> {
  const maxWaitMs = devLockHandoffMs()
  const deadline = Date.now() + maxWaitMs
  let announced = false
  let shutdownRequested = false
  for (;;) {
    try {
      return acquireLock(lockPath)
    } catch (error) {
      const remaining = deadline - Date.now()
      if (!(error instanceof DaemonLockHeldError) || maxWaitMs === 0 || remaining <= 0) {
        throw error
      }
      if (error.pid === process.pid) {
        const adopted = adoptCurrentProcessLock(lockPath)
        onSameProcessAdopted(error)
        return adopted
      }
      if (!announced) {
        announced = true
        onWait(error, maxWaitMs)
      }
      if (!shutdownRequested) {
        const endpoint = readControlFile(Paths.controlFile)
        if (endpoint !== null && endpoint.pid === error.pid) {
          // The endpoint belongs to the live lock owner, but only an old dev
          // generation may be replaced. A manually started daemon stays safe.
          if (endpoint.devWatch !== true) throw error
          const outcome = await requestShutdown(endpoint, Math.min(5_000, remaining))
          if (outcome !== 'accepted') throw error
          shutdownRequested = true
          onShutdownRequested(error)
        }
      }
      await Bun.sleep(Math.min(50, remaining))
    }
  }
}

interface DbCorruptionFailure extends Error {
  readonly dbPath: string
  readonly checkErrors: readonly string[]
}

function isDbCorruptionFailure(error: unknown): error is DbCorruptionFailure {
  return (
    error instanceof Error &&
    error.name === 'DbCorruptionError' &&
    'dbPath' in error &&
    typeof error.dbPath === 'string' &&
    'checkErrors' in error &&
    Array.isArray(error.checkErrors) &&
    error.checkErrors.every((entry) => typeof entry === 'string')
  )
}

/** RFC-213 — human-facing fail-closed message: list backups + the restore command. */
function formatDbCorruptionGuidance(err: DbCorruptionFailure): string {
  const lines = [
    '',
    '✖ agent-workflow: database corruption detected — refusing to start.',
    `  db:          ${err.dbPath}`,
    `  quick_check: ${err.checkErrors.slice(0, 3).join('; ')}`,
    '',
  ]
  let backups: string[] = []
  try {
    backups = readdirSync(Paths.backupsDir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => join(Paths.backupsDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {
    /* no backups dir */
  }
  if (backups.length === 0) {
    lines.push(`  No backups found under ${Paths.backupsDir}.`)
    lines.push('  If you have a backup tarball elsewhere: agent-workflow restore <tarball>')
  } else {
    lines.push('  Available backups (newest first):')
    for (const b of backups.slice(0, 5)) lines.push(`    ${b}`)
    lines.push('')
    lines.push(`  Recover with: agent-workflow restore ${backups[0]}`)
  }
  lines.push('  (Last resort, unsafe: AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK=1 agent-workflow start)')
  lines.push('')
  return lines.join('\n')
}

/** RFC-275 — actionable boot refusal before any route or scheduler starts. */
function formatDbSchemaDriftGuidance(err: DbSchemaDriftError): string {
  const lines = [
    '',
    '✖ agent-workflow: database schema drift detected — refusing to start.',
    `  db:    ${err.dbPath}`,
    `  stage: ${err.stage}`,
    '  differences:',
  ]
  for (const difference of err.differences.slice(0, 10)) {
    lines.push(`    - ${formatSchemaDifference(difference)}`)
  }
  if (err.totalDifferences > 10) {
    lines.push(`    - … and ${err.totalDifferences - 10} more`)
  }
  lines.push(
    '',
    '  Safe recovery options:',
    '    1. Restore a verified backup.',
    '    2. If this is a disposable development database, recreate it.',
    '    3. If the schema change is intentional, add a new forward migration.',
    '',
    '  Do not edit __drizzle_migrations or rewrite an already-applied migration.',
    '',
  )
  return lines.join('\n')
}

export async function startCommand(opts: StartOptions = {}): Promise<void> {
  // 1. Logger — must come before lock so failures land in stdout/file.
  configureLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    logFile: Paths.daemonLog,
  })
  const log = createLogger('daemon')
  const digitalEmployeeTypePackageDriftPolicy =
    !IS_EMBEDDED &&
    devLockHandoffMs() > 0 &&
    process.env.AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY === '1'
      ? 'draft-overlay'
      : 'reject'

  // 2. Single-instance lock.
  let lock: Lock
  try {
    lock = await acquireStartLock(
      Paths.lock,
      (owner, maxWaitMs) => {
        log.info('waiting for previous daemon lock handoff', {
          replacementPid: process.pid,
          pid: owner.pid,
          lock: owner.lockPath,
          maxWaitMs,
        })
      },
      (owner) => {
        log.info('requested previous dev daemon shutdown', {
          pid: owner.pid,
          lock: owner.lockPath,
        })
      },
      (owner) => {
        log.info('adopted current-process lock for Bun watch generation', {
          pid: owner.pid,
          lock: owner.lockPath,
        })
      },
    )
  } catch (err) {
    if (err instanceof DaemonLockHeldError) {
      log.error('another daemon is already running', { pid: err.pid, lock: err.lockPath })
      console.error(
        `agent-workflow: another daemon is already running (PID ${err.pid})\n` +
          `  lock file: ${err.lockPath}\n` +
          `  if it is stale, remove the lock file manually and try again`,
      )
      process.exit(1)
    }
    throw err
  }
  log.info('lock acquired', { pid: lock.pid, lock: lock.path })

  // 2.5 — RFC-213: resolve the migrations folder and apply a staged ("hot")
  // restore BEFORE anything reads state. We hold the lock (acquired above), so
  // exactly one process consumes it; the DB is not open yet. Impl-gate P2-12
  // (2026-07-22): this used to run AFTER loadConfig, so the config.json the
  // restore just brought back only took effect one restart later — moved ahead
  // of loadConfig so the applying boot already runs on the restored config.
  //
  // P-5-05: in the compiled single-binary, the .sql files + meta/_journal.json
  // live inside the executable. drizzle's migrator needs a filesystem path,
  // so we extract them once per start into ~/.agent-workflow/runtime/migrations
  // and point the migrator there.
  // `ms` is deliberate: this step is O(number of migrations) filesystem
  // writes and grows with every migration added. It once reached ~23.5s on a
  // Windows CI runner and blew the e2e harness's 30s daemon-ready budget
  // while being completely invisible in the logs — the duration is what makes
  // that trend observable before it breaks something again.
  const extractStartedAt = Date.now()
  const migrationsFolder = await resolveMigrationsFolder({
    // `force`: boot has always re-extracted unconditionally; keeping that keeps
    // an interrupted previous extraction from surviving into this boot.
    force: true,
    onExtracted: (count, dir) => {
      log.info('extracted embedded migrations', {
        count,
        ms: Date.now() - extractStartedAt,
        dir,
      })
    },
  })
  const logicalSchemaContract = buildLogicalSchemaContract()
  const bootGeneration = readDatabaseGeneration({
    pointerPath: Paths.databaseGenerationPointer,
    migrationsDir: Paths.databaseMigrationsDir,
    expectedSchemaDigest: logicalSchemaContract.digest,
  })
  // A failure inside applyPendingRestoreIfAny self-heals (impl-gate P1-1): the
  // staged dir is quarantined and the boot continues on the untouched DB. The
  // catch below only guards truly unexpected filesystem-level throws.
  if (bootGeneration.payload.provider === 'sqlite') {
    try {
      const applied = await applyPendingRestoreIfAny({
        appHome: Paths.root,
        dbPath: Paths.db,
        migrationsFolder,
        postOpenRecovery: composeSqlitePostRestoreRecovery(),
      })
      if (applied) log.warn('staged restore applied on boot', { db: Paths.db })
    } catch (err) {
      lock.release()
      console.error(
        `agent-workflow: staged restore failed unexpectedly — refusing to boot with an unknown DB state.\n` +
          `  ${err instanceof Error ? err.message : String(err)}\n` +
          `  The pre-restore safety backup (if taken) is under ${join(Paths.root, 'backups')}/.\n` +
          `  To abandon the staged restore and boot normally: rm -rf ${join(Paths.root, '.restore-pending')}`,
      )
      process.exit(1)
    }
  }

  // 3. Load config; honor logLevel if user set non-default in config.
  const config = loadConfig(Paths.config)
  if (config.logLevel !== 'info') {
    configureLogger({ level: config.logLevel })
  }
  log.info('config loaded', { path: Paths.config, language: config.language, theme: config.theme })

  // 4. git version probe — RFC-130 D7: every node run merge-backs via
  // `git merge-tree --write-tree` (git >= 2.38). On older git the daemon boots
  // fine and every task dies at merge-back (AFTER its agent already ran) with a
  // cryptic `merge-back-failed: git merge-tree: usage: ...` — refuse at boot
  // instead. Unlike optional agent runtimes, git is a platform dependency for
  // repository/worktree/snapshot/merge-back operations. Side effect: populate
  // the RFC-034 capability cache read by resolveSubmoduleParams.
  const gitCaps = await detectGitCapabilities()
  const gitGateError = mergeTreeGateError(gitCaps)
  if (gitGateError !== null) {
    log.error('git incompatible', {
      found: gitCaps.version?.raw ?? null,
      requiredMinimum: MIN_GIT_VERSION,
    })
    console.error(
      `agent-workflow: ${gitGateError}\n` +
        `  upgrade git to >= ${MIN_GIT_VERSION} and restart; the daemon's PATH must resolve the upgraded binary.`,
    )
    lock.release()
    process.exit(1)
  }
  log.info('git probe ok', { version: gitCaps.version?.raw ?? null })

  // RFC-111 D10: claude-code is optional — probe it SOFT (warn only, NEVER
  // refuse to start) when it is the configured default. RFC-226 makes OpenCode
  // optional too, but deliberately does not probe it here at all: its
  // version/build admission belongs to explicit runtime validation and use.
  if (config.defaultRuntime === 'claude-code') {
    const ccDriver = getRuntimeDriver('claude-code')
    const claudeProbe = await ccDriver.probe(ccDriver.defaultBinary(config)[0]!)
    if (!claudeProbe.compatible) {
      log.warn('claude-code default runtime unavailable (nodes selecting it will fail)', {
        binary: claudeProbe.binary,
        found: claudeProbe.version,
        requiredMinimum: ccDriver.minVersion,
        reason: claudeProbe.incompatibleReason ?? 'not found',
      })
    } else {
      log.info('claude-code probe ok', {
        version: claudeProbe.version,
        binary: claudeProbe.binary,
      })
    }
  }

  // Provider-independent bootstrap secrets are needed by either selected
  // composition. They are created before opening a client, but no owner module
  // receives them until its verified provider graph is composed below.
  const secretBox = createSecretBox(Paths.secretKeyFile)
  log.info('secret box ready', { keyFile: Paths.secretKeyFile })
  const token = ensureTokenFile(Paths.tokenFile)
  log.info('token ready', { tokenFile: Paths.tokenFile })
  const dbVersion = existsSync(migrationsFolder)
    ? readdirSync(migrationsFolder).filter((file) => file.endsWith('.sql')).length
    : 0
  const deferredDatabaseMigrationAdmission = _createDeferredDatabaseMigrationAdmission()

  // 5. DB — resolve the verified live generation before opening any provider
  // client. The pointer is authoritative; config may supply mechanism settings
  // but cannot silently select a different database.
  const databaseProvider = resolveDatabaseProviderRuntime({
    config: config.database,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract: logicalSchemaContract,
  })

  // DB — open + apply migrations. dbVersion = number of SQL files in the
  // bundled migrations folder (== the highest version we've applied, since
  // openDb() applies all pending migrations on startup). The migrations folder
  // itself (and any staged restore) was already resolved/applied at step 2.5.

  // RFC-213/RFC-223: raw pre-migration safety backup BEFORE openDb applies
  // migrations. A pending migration without its rollback generation is fatal;
  // backupOnMigration=false is the operator's explicit opt-out.
  if (databaseProvider.provider === 'postgresql') {
    const initialLifecycle = Object.freeze({
      operationId: 'daemon-start',
      provider: 'postgresql' as const,
      generationId: databaseProvider.generation.payload.generationId,
    })
    const initial = await composePostgresqlProviderSession({
      provider: databaseProvider,
      config: requirePostgresqlConfig(config),
      token,
      secretBox,
      dbVersion,
      migrationAdmission: deferredDatabaseMigrationAdmission.admission,
      sourceWriteWindow: deferredDatabaseMigrationAdmission.sourceWriteWindow,
      log,
    })
    const daemonProviderBootstrap = createDaemonProviderBootstrap({
      initialSession: initial.session,
      sessionFactory: {
        async create(lifecycleInput) {
          if (lifecycleInput.provider === 'sqlite') {
            throw new Error('sqlite-provider-session-source-retired')
          }
          const nextConfig = loadConfig(Paths.config)
          const nextProvider = resolveDatabaseProviderRuntime({
            config: nextConfig.database,
            sqlitePath: Paths.db,
            generationPointerPath: Paths.databaseGenerationPointer,
            operationsRoot: Paths.databaseMigrationsDir,
            contract: logicalSchemaContract,
          })
          if (
            nextProvider.provider !== 'postgresql' ||
            nextProvider.generation.payload.generationId !== lifecycleInput.generationId
          ) {
            await nextProvider.close()
            throw new Error('postgresql-daemon-target-generation-mismatch')
          }
          return (
            await composePostgresqlProviderSession({
              provider: nextProvider,
              config: requirePostgresqlConfig(nextConfig),
              token,
              secretBox,
              dbVersion,
              migrationAdmission: deferredDatabaseMigrationAdmission.admission,
              sourceWriteWindow: deferredDatabaseMigrationAdmission.sourceWriteWindow,
              log,
            })
          ).session
        },
      },
      createMigrationAdmission: createDatabaseMigrationDaemonAdmission,
    })
    deferredDatabaseMigrationAdmission.bind(daemonProviderBootstrap)
    await initial.session.resume(initialLifecycle)
    await servePostgresqlDaemon({
      bootstrap: daemonProviderBootstrap,
      authRuntime: initial.application.core.authRuntime,
      token,
      bindHost: opts.host ?? config.bindHost,
      bindPort: opts.port ?? config.bindPort ?? 0,
      lock,
      log,
    })
  }

  if (databaseProvider.provider !== 'sqlite') {
    throw new Error('sqlite-daemon-provider-narrowing-failed')
  }

  await maybePreMigrationBackup({
    appHome: Paths.root,
    dbPath: Paths.db,
    migrationsFolder,
    enabled: config.backupOnMigration,
  })

  let db: ReturnType<typeof databaseProvider.openClient>
  try {
    db = databaseProvider.openClient({
      migrationsFolder,
      synchronous: config.sqliteSynchronous,
      // RFC-311 capacity/telemetry pragmas (all settings-configurable).
      pageCacheMib: config.sqlitePageCacheMib,
      mmapMib: config.sqliteMmapMib,
      slowQueryMs: config.sqliteSlowQueryMs,
      skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',
    })
  } catch (err) {
    if (isDbCorruptionFailure(err)) {
      // RFC-213 fail-closed: never serve a corrupt DB. Print the available
      // backups + the exact restore command, then exit non-zero. The DB is
      // unwritable, so this does NOT record a recovery_event.
      lock.release()
      process.stderr.write(formatDbCorruptionGuidance(err))
      process.exit(1)
    }
    if (err instanceof DbSchemaDriftError) {
      lock.release()
      process.stderr.write(formatDbSchemaDriftGuidance(err))
      process.exit(1)
    }
    throw err
  }

  // RFC-300 composition: integration owns the direct-Webhook attribution
  // predicate; lifecycle owns the atomic terminal status+claim write; GC owns
  // physical deletion. Read config at each transition so the setting is hot.
  registerTerminalWorkspacePrunePolicy(
    composeSqliteWebhookTerminalWorkspacePrunePolicy({
      db,
      enabled: () => loadConfig(Paths.config).webhookTaskWorkspaceAutoCleanup,
    }),
  )
  log.info('db ready', { path: Paths.db, dbVersion })
  const providerSessionLifecycle = Object.freeze({
    operationId: 'daemon-start',
    provider: databaseProvider.provider,
    generationId: databaseProvider.generation.payload.generationId,
  })

  // RFC-282 §4.3 — runtime declaration self-check, before any business
  // service: every registered driver must state a stance on every declaration
  // face (a declared-but-unimplemented face makes the verification layer
  // believe it is verifying — RFC-247 rationale). 'not-modeled' policy rows
  // are reported separately so the gap stays visible.
  {
    const { assertRuntimeDeclarations } = await import('@/services/runtime/selfCheck')
    const { getRuntimeDriver, RUNTIME_KINDS } = await import('@/services/runtime')
    const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))
    if (notModeled.length > 0) {
      log.info('runtime declaration self-check: not-modeled dispositions', { notModeled })
    }
  }

  // RFC-279: migration 0147 can leave a direct-upgrade legacy URL under a
  // closed escrow prefix. Converge credentials immediately after openDb,
  // before any recovery, seeder, scheduler, or HTTP behavior can observe the
  // database. The provider-independent SecretBox was created before provider
  // selection and is reused by this selected SQLite graph.
  const realtimePolicy = createDaemonRealtimePolicyBinding()
  const providerCore = composeSqliteDaemonProviderCore({
    db,
    sourceWriteWindow: deferredDatabaseMigrationAdmission.sourceWriteWindow,
    appHome: Paths.root,
    dbPath: Paths.db,
    lockPath: Paths.lock,
    secretBox,
    realtimePolicy: realtimePolicy.policy,
    onCredentialRevoked: triggerRevalidation,
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
  const repositoryWorkspaceStore = providerCore.repositoryWorkspaceStore
  const repositoryTransportRepository = providerCore.repositoryTransportCredentialRepository
  await ensureCredentialsSealed(repositoryWorkspaceStore, secretBox)
  const repositoryTransportModule = composeRepositoryTransportCredentials(
    repositoryTransportRepository,
    secretBox,
  )
  await reconcileRepositoryTransportConnectionProjections(
    repositoryTransportRepository,
    repositoryTransportModule.adminConnections,
  )
  const repositoryMetadataConnections = createCodeHostConnectionsService({
    secretBox,
    repositoryTransport: repositoryTransportModule.adminConnections,
  })
  const developmentDeliveryProvider = createSqliteDevelopmentDeliveryProvider({
    db,
    secretBox,
    connections: repositoryMetadataConnections,
    pipeline: composeSqlitePipelineEvidenceRunner(db),
  })
  const developmentWorkspaceRepositoryPreparation = createDevelopmentWorkspaceRepositoryPreparation(
    {
      store: repositoryWorkspaceStore,
      appHome: Paths.root,
      secretBox,
    },
  )
  const repositoryEndpointDiscovery = createRepositoryEndpointDiscovery({
    async resolveConnection(provider) {
      const connection = await repositoryMetadataConnections.resolve(provider)
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
    secretBox,
    appHome: Paths.root,
    endpointDiscovery: repositoryEndpointDiscovery,
  })
  const identityAccess = providerCore.identityAccess
  const resourceCatalog = composeSqliteResourceCatalog({ db })
  const agentResourceIntegrity = composeSqliteAgentResourceIntegrity({
    db,
    authorization: resourceCatalog.authorization,
  })
  const taskExecutionResourceSnapshots = composeTaskExecutionResourceBinding(
    legacyTaskExecutionResourceDependencies,
  )
  const taskExecutionResources = createSqliteTaskExecutionResourceBinding(
    db,
    taskExecutionResourceSnapshots,
  )
  const memoryInjectionQueries = composeSqliteMemoryInjectionQueries(db)
  const runtimeSessionLeases = createSqliteRuntimeSessionLeaseOperations(db)
  const runtimeRegistry = providerCore.runtimeRegistry
  let collaborationContext: ReturnType<typeof createCollaborationCommandContext> | null = null
  const requireCollaborationContext = (): ReturnType<typeof createCollaborationCommandContext> => {
    if (collaborationContext === null) {
      throw new Error('collaboration-command-context-not-bound')
    }
    return collaborationContext
  }
  const memoryOperations = composeSqliteMemoryOperations({
    db,
    injectionQueries: memoryInjectionQueries,
    reviewedArtifacts: {
      read: async (finalPath) =>
        await readCommittedReviewArtifactBody(requireCollaborationContext(), finalPath),
    },
    catalogBinding: {
      contexts: identityAccess.contexts,
      authorization: composeResourceScopeAuthorizationBinding(),
    },
  })
  const memoryCatalog = memoryOperations.catalog
  if (memoryCatalog === undefined) throw new Error('memory-catalog-not-composed')

  const broadcastAlert = (
    row: { taskId: string; rule: string; severity: 'warning' | 'error' },
    transition: 'new' | 'promoted',
  ): void => {
    tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
      type: 'lifecycle.alert',
      taskId: row.taskId,
      rule: row.rule,
      severity: row.severity,
      transition,
    })
  }
  const broadcastResolved = (taskId: string): void => {
    tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
      type: 'lifecycle.alert.resolved',
      taskId,
    })
  }

  const deferredScheduler = createDeferredSchedulerDriver()
  const taskStartDepsFor = (actorUserId: string) => ({
    ...buildStartTaskDeps(
      db,
      deferredScheduler.driver,
      Paths.config,
      actorUserId,
      secretBox,
      identityAccess,
    ),
    agentLaunchResources: Object.freeze({
      resources: composeSqliteAgentLaunchResourceOperations(db),
      integrity: agentResourceIntegrity.launch,
    }),
  })
  const fusionStartDeps = Object.freeze({
    actorUserId: SYSTEM_USER_ID,
    secretBox,
    identityAccess,
    repositoryWorkspace: providerCore.repositoryWorkspaceStore,
    runtimeSessionLeases,
    configPath: Paths.config,
    ...(config.subagentLiveCapture === undefined
      ? {}
      : { subagentLiveCapture: config.subagentLiveCapture }),
    ...resolveLaunchRuntimeConfig(Paths.config),
  })
  const taskExecutionProvider: SelectedSqliteTaskExecutionProviderRuntime =
    composeSqliteTaskExecutionProviderRuntime(db, {
      runtime: {
        memoryInjectionQueries,
        collaborationRuntime: createSqliteCollaborationRuntimeMechanics(db),
        runtimeSessionLeases,
        runtimeRegistry,
        identityAccess: Object.freeze({
          delegatedRequests: identityAccess.delegatedRequests,
          taskExecutionResources,
        }),
        dynamicWorkflow: Object.freeze({
          persistence: composeSqliteDynamicWorkflowPersistence(db),
          validationContext: composeSqliteDynamicWorkflowValidationContext(db),
        }),
        codeHostConnections: repositoryMetadataConnections,
        repositoryPublicationTransport,
      },
      routeLaunch: {
        configPath: Paths.config,
        // No `deferRepoPreparation` here on purpose. RFC-287 G7 defers repo
        // preparation for the JSON `/api/tasks` launch (see
        // `sqliteTaskRouteOperations`); the Agent and Workgroup launches kept
        // the synchronous contract, and the task wizard depends on it: an
        // unresolvable ref must be refused in the HTTP call with the server's
        // own message and the available refs, and must not mint a task row that
        // can only fail later.
        executionFor: (actor) => Object.freeze({ ...taskStartDepsFor(actor.user.id) }),
      },
      routes: ({ readModels }) => {
        const routeCollaborationContext = createCollaborationCommandContext({
          db,
          appHome: Paths.root,
          taskExecutionReadModels: readModels,
          reviewDecisions: createSqliteReviewDecisionCommand({ db, appHome: Paths.root }),
          questionDispatches: createSqliteQuestionDispatchCommand(db),
          clarifyDecisions: createSqliteClarifyDecisionCommand(
            db,
            memoryOperations.distillCommands,
          ),
        })
        collaborationContext = routeCollaborationContext
        return {
          collaboration: routeCollaborationContext,
          startDepsFor: (actor) => taskStartDepsFor(actor.user.id),
          multipart: {
            secretBox,
            configPath: Paths.config,
            schedulerDriver: deferredScheduler.driver,
            identityAccess: Object.freeze({
              directAuthority: identityAccess.directAuthority,
              taskExecutionResources,
            }),
          },
          resourceAuthorityFor: (actor) =>
            Object.freeze({
              actor,
              authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
              resources: taskExecutionResources,
            }),
          assertWorkflowLaunchable: (workflow) => assertWorkflowSnapshotLaunchable(db, workflow),
          appHome: Paths.root,
        }
      },
      lifecycleRepair: {
        appHome: Paths.root,
        deps: taskStartDepsFor(SYSTEM_USER_ID),
        onAlert: broadcastAlert,
        onResolved: broadcastResolved,
      },
      fusion: {
        appHome: Paths.root,
        startDeps: fusionStartDeps,
      },
      trigger: {
        executionFor: (actor) => ({
          ...taskStartDepsFor(actor.user.id),
          deferRepoPreparation: true,
        }),
      },
      rootResumeRuntime: () => ({
        runConfig: {
          appHome: Paths.root,
          ...(config.subagentLiveCapture === undefined
            ? {}
            : { subagentLiveCapture: config.subagentLiveCapture }),
          ...resolveLaunchRuntimeConfig(Paths.config),
        },
      }),
      repositoryPreparationRetry: Object.freeze({
        async retry(taskId: string) {
          await retryRepositoryPreparation(db, taskId, taskStartDepsFor(SYSTEM_USER_ID))
        },
      }),
    })
  deferredScheduler.bind(taskExecutionProvider.runtime.schedulerDriver)
  const taskExecutionPersistence = taskExecutionProvider.persistence
  const taskExecutionRuntime = taskExecutionProvider.runtime
  if (collaborationContext === null) {
    throw new Error('collaboration-command-context-not-composed')
  }
  const scheduledTaskRuntime = composeSqliteScheduledTaskRuntime({
    db,
    resources: composeIntegrationTriggerResourceBinding(
      { canViewResourceInTx, assertNotBuiltin },
      composeDigitalEmployeeIntegrationTriggerParticipant,
    ),
    validation: Object.freeze({
      assertWorkflowLaunchable: (
        workflow: Parameters<typeof assertWorkflowSnapshotLaunchable>[1],
      ) => assertWorkflowSnapshotLaunchable(db, workflow),
      assertAgentIntegrity: (agentIds: readonly string[]) =>
        agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
    }),
    resourceAclChanged: () => triggerRevalidation('resource-acl-changed'),
  })
  const integrationIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionResources,
  })
  const fusionOperations = composeSqliteFusionOperations({
    db,
    appHome: Paths.root,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.fusion,
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
  const removedCredentialLeases = cleanupOrphanedGitCredentialLeases(Paths.root)
  if (removedCredentialLeases > 0) {
    log.info('orphaned git credential leases removed', { count: removedCredentialLeases })
  }

  // 5a. RFC-223 PR-5: the ONE fail-closed skill identity barrier. It must be
  // the first skill DB/FS behavior after credential convergence: recover every
  // legacy/current structural op while locks remain evidence, migrate
  // skills/{name} -> skills/{id}, and prove DB/FS/FK consistency before users,
  // orphan reaping, reconcilers, seeders, schedulers, fusion, or HTTP can run.
  const skillCatalogBoot: SkillCatalogBootParticipant = composeSqliteSkillCatalogBoot({
    db,
    appHome: Paths.root,
  })
  {
    const report = await skillCatalogBoot.runIdentityMigrationBarrier()
    if (report.recoveredOperations > 0 || report.removedHusks > 0 || report.migratedSkills > 0) {
      log.info('skill identity migration barrier complete', { ...report })
    }
  }
  // RFC-223 PR-4: finish provenance recovery before any fusion recovery,
  // seeder, scheduler, or HTTP path can observe a historical name-only row.
  // Fail CLOSED: an unexpected repair error aborts boot rather than serving a
  // database whose fusion identity is ambiguous.
  {
    const { repairFusionProvenance } = await import('@/services/fusion')
    const report = await repairFusionProvenance(fusionOperations.persistence)
    if (Object.values(report).some((count) => count > 0)) {
      log.info('fusion provenance repair complete', { ...report })
    }
  }
  // Activate the boot-epoch availability gate while its verified set is still
  // empty. Every persisted skill stays hidden from all consumers and HTTP until
  // the per-skill background reverify explicitly admits it (or quarantines it).
  skillCatalogBoot.activateAvailabilityGate()

  // RFC-036 bootstrap hint: if no real user has been created yet, log a
  // one-shot pointer to the CLI so admins know how to leave single-user mode.
  try {
    if (await providerCore.authRuntime.isBootstrapRequired()) {
      log.info(
        'first multi-user run? create your admin via `agent-workflow user create --admin --username <name>`',
      )
    }
  } catch {
    /* users service may not be available in degraded mode; ignore */
  }

  const taskExecutionLockProof = createExclusiveDaemonLockProof({
    daemonGeneration: DAEMON_GENERATION,
    acquiredAt: Date.now(),
    lockReceiptDigest: sha256Hex(`${lock.path}\u0000${lock.pid}\u0000${DAEMON_GENERATION}`),
  })
  const ownershipRecoveryPreparation = prepareTaskExecutionRecovery({
    db,
    lockProof: taskExecutionLockProof,
  })
  if (ownershipRecoveryPreparation.revokedTaskIds.length > 0) {
    log.warn('revoked task owners left by a previous daemon', {
      tasks: ownershipRecoveryPreparation.revokedTaskIds.length,
    })
  }

  // 5b. P-4-07: reap orphan runs from the previous (crashed/SIGKILLed) daemon
  // process. Any task/node_run left in 'running' is flipped to 'interrupted'
  // with task.error_message = 'daemon-restart' so the UI surfaces what
  // happened.
  const reap = await reapOrphanRuns(taskExecutionPersistence.recoveryAdministration)
  if (reap.tasks > 0 || reap.runs > 0) {
    log.warn('reaped orphan runs from previous daemon', {
      tasks: reap.tasks,
      runs: reap.runs,
    })
  }
  const repairedRuntimeLeases = await repairRuntimeSessionLeasesAfterOrphanReap(
    runtimeSessionLeases,
    true,
  )
  if (repairedRuntimeLeases > 0) {
    log.info('released runtime session leases held by terminal orphan runs', {
      leases: repairedRuntimeLeases,
    })
  }
  const ownershipRecovery = await finalizeTaskExecutionRecovery({
    db,
    lockProof: taskExecutionLockProof,
    processEvidence: {
      orphanReaperCompleted: true,
      orphanTasks: reap.tasks,
      orphanRuns: reap.runs,
      repairedRuntimeLeases,
    },
    codeHostProbe: (descriptor) =>
      probeCodeHostMutation({
        descriptor,
        resolveConnection: (provider) => repositoryMetadataConnections.resolve(provider),
      }),
  })
  if (
    ownershipRecovery.releasedTaskIds.length > 0 ||
    ownershipRecovery.outcomeUnknownTaskIds.length > 0
  ) {
    log.info('durable task execution recovery finalized', {
      released: ownershipRecovery.releasedTaskIds.length,
      outcomeUnknown: ownershipRecovery.outcomeUnknownTaskIds.length,
      recoveredProcessEffects: ownershipRecovery.recoveredProcessEffectIds.length,
      recoveredCodeHostEffects: ownershipRecovery.recoveredCodeHostEffectIds.length,
      retryAuthorizedCodeHostEffects: ownershipRecovery.retryAuthorizedCodeHostEffectIds.length,
    })
  }

  // RFC-328 terminal maintenance is durable and outlives task-row deletion.
  // Resume exact delete claims before any automatic continuation is opened.
  try {
    const deleteRecovery = await recoverInterruptedTaskDeletes(db)
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
  try {
    const archiveRecovery = await recoverInterruptedArchives(db)
    if (archiveRecovery.promoted.length > 0 || archiveRecovery.discarded.length > 0) {
      log.info('terminal task archive recovery', archiveRecovery)
    }
  } catch (err) {
    log.warn('terminal task archive recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  try {
    const workspaceRecovery = await recoverInterruptedWorkspaceGc(db)
    if (workspaceRecovery.completed.length > 0 || workspaceRecovery.failed.length > 0) {
      log.info('terminal workspace maintenance recovery', { ...workspaceRecovery })
    }
  } catch (err) {
    log.warn('terminal workspace maintenance recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-300: singleton lock + orphan reap prove the previous daemon no longer
  // owns these workspaces. Resume every durable claim before HTTP/auto-resume;
  // this does not discover historical unclaimed terminal tasks.
  try {
    const resumed = await runClaimedWebhookWorkspacePrunes(db, { isTaskActive })
    if (resumed.removed.length > 0 || resumed.failed.length > 0) {
      log.info('webhook terminal workspace prune recovery', { ...resumed })
    }
  } catch (err) {
    log.warn('webhook terminal workspace prune recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5b2/5b3（已退役）—— RFC-132 的两个 boot 垫片（legacy immediate rounds /
  // legacy cross stop）由 RFC-217 T8 收编为一次性 migration 0107（垫片模块
  // 随之删除）；migration 恰好一次的语义取代 boot-once 幂等重放。

  // 5b4. RFC-165 (R3-2-r4): backfill workspace tombstones for terminal tasks
  // whose directory vanished before the tombstone columns existed (pre-165 GC
  // deleted dirs without stamping anything). Revive paths (resume / retry /
  // sync / repair / auto-resume) then 410 deterministically instead of
  // resurrecting a ghost. Must run BEFORE the HTTP server serves revive
  // routes and before auto-resume (step 8+) — 幂等 + best-effort.
  try {
    const { reconcileLegacyPrunedWorkspaces } = await import('@/services/gc')
    await reconcileLegacyPrunedWorkspaces(db)
  } catch (err) {
    log.warn('legacy pruned-workspace reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5b5. RFC-165 (§9): heal stored path-mode scheduled launch payloads to their
  // faithful file:// form (fetchBeforeLaunch:true / missing dirs → disabled with
  // an explanatory lastError). MUST run before the HTTP server serves the
  // scheduled read/edit routes AND before the scheduler ticker fires — 幂等 +
  // best-effort.
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

  // 5b5. RFC-170 T6 (Codex re-review F9): recover fusion DECISION half-states left
  // by a crash mid-approve/mid-reject (multi-tx decisions). Roll forward an
  // 'applying' whose version already committed, roll back the rest, and fail a
  // 'running'+currentTaskId=null (reject that never attached its task). Best-effort.
  try {
    const { recoverFusionDecisions } = await import('@/services/fusion')
    const r = await recoverFusionDecisions(fusionOperations.persistence)
    if (r.rolledForward + r.rolledBack + r.rejectFailed > 0) {
      log.info('fusion decision recovery on boot', { ...r })
    }
  } catch (err) {
    log.warn('fusion decision recovery on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5c. RFC-101: backfill a v1 snapshot for any managed skill predating skill
  // versioning, and re-sync a live files/ left stale by a crash between the
  // version-archive tx and the live-files copy. Idempotent + best-effort.
  try {
    await skillCatalogBoot.reconcileLiveFiles()
  } catch (err) {
    log.warn('skill-version reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5e. RFC-101: ensure the built-in skill-fusion agent + workflow exist (so a
  // fusion launch never has to seed them on the hot path, and they show up in
  // the workflows list). Idempotent; createFusion also lazy-seeds defensively.
  try {
    const { seedFusionResources } = await import('@/services/fusion')
    await seedFusionResources(fusionOperations.persistence)
  } catch (err) {
    log.warn('fusion resource seed on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-310: business templates are platform resources, not schema data. Seed
  // them after DB admission so pure migrations remain free of resource rows.
  const digitalEmployeeAgentTemplates = composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant(
    db,
    composeDigitalEmployeeAgentTemplateCatalogParticipant,
  )
  await ensureDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates)

  // 5e-bis. RFC-307: sample content, ONCE per install. Marker-gated rather
  // than existence-gated — a user who deletes the samples means it, and
  // re-seeding on the next restart would be the platform arguing. Never fatal:
  // no samples is exactly the state every install before this RFC was in.
  try {
    const { seedDemoContent } = await import('@/services/demoSeed')
    const result = await seedDemoContent({
      resourceCatalog: composeSqliteDemoResourceCatalogSeedParticipant(db),
      codeCapability: composeSqliteCodeCapabilityDemoSeedParticipant(db),
    })
    if (result.seeded) log.info('demo content seeded (delete it and it stays deleted)')
  } catch (err) {
    log.warn('demo content seed on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5f. RFC-112/153: on FIRST startup (empty runtimes table) seed opencode /
  // claude-code as ordinary rows so agents / config.defaultRuntime can reference
  // them by name and the Settings list shows them out of the box. RFC-153: they
  // are editable + deletable now; a deleted row is NOT re-seeded (seed no-ops on a
  // non-empty table). migrateConfigIntoBuiltins then backfills binary from config.
  await initializeRuntimeRegistryBoot({
    operations: runtimeRegistry,
    config,
    configPath: Paths.config,
    onRecoverableFailure(error) {
      log.warn('builtin runtime seed/migration on boot failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  // RFC-238 — complete boot recovery before accepting a playground request.
  // The routes resolve the same DB-keyed daemon singleton.
  let mcpCatalogRef: McpCatalogModule | null = null
  const mcpRuntimeTests = getMcpRuntimeTestService({
    ...composeSqliteMcpRuntimeTestProvider(db),
    async loadMcp(mcpId) {
      if (mcpCatalogRef === null) throw new Error('mcp-catalog-not-composed')
      const identity = await admitDaemonIdentity(identityAccess)
      if (identity === null) throw new Error('mcp-runtime-test-authority-not-admitted')
      return mcpCatalogRef.queries.get(identity.actor, { id: mcpId })
    },
    loadRuntime: (name) => runtimeRegistry.getRuntime(name),
    configPath: Paths.config,
    appHome: Paths.root,
  })
  const mcpProbeStore = composeSqliteMcpProbeStore(db)
  const mcpCatalog = composeMcpCatalog({
    db,
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
      prepareDelete: (mcpId: string) => mcpRuntimeTests.prepareMcpDelete(mcpId),
      reconcileDurableIntents: () => mcpRuntimeTests.reconcileDurableIntents(),
    }),
    transitionMutationInTx: transitionMcpRuntimeTestsInTx,
    deletePreparedInTx: deletePreparedMcpRuntimeTestsInTx,
  })
  mcpCatalogRef = mcpCatalog
  const agentCatalog = composeAgentCatalog({
    db,
    importQueries: composeSqliteAgentImportQueries(db),
    resourceIntegrityQueries: agentResourceIntegrity.queries,
  })
  const skillCatalog = composeSkillCatalog({ db, appHome: Paths.root })
  const pluginCatalog = composePluginCatalog({ db, coordinator: pluginOperationCoordinator })
  const workflowCatalog = composeWorkflowCatalog({ db })
  const workgroupCatalog = composeWorkgroupCatalog({ db })
  const capabilityTemplateAccess: Parameters<
    typeof composeSqliteCapabilityTemplateOperations
  >[0]['access'] = {
    filterVisible(actor, rows) {
      return resourceCatalog.authorization.filterVisibleRows(actor, 'capability_template', rows)
    },
    canView(actor, row) {
      return resourceCatalog.authorization.canViewResource(actor, 'capability_template', row)
    },
    requireEdit(actor, row) {
      return resourceCatalog.authorization.requireResourceEdit(actor, 'capability_template', row)
    },
    requireGovern(actor, row) {
      return resourceCatalog.authorization.requireResourceGovern(actor, 'capability_template', row)
    },
    assertNameUnchangedForEditor: resourceCatalog.authorization.assertNameUnchangedForEditor,
  }
  const capabilityTemplateOperations = composeSqliteCapabilityTemplateOperations({
    db,
    access: capabilityTemplateAccess,
  })
  const developmentAdapterConfigOperations = composeDevelopmentAdapterConfigOperations(db)
  const developmentConfigAccess: DevelopmentConfigResourceAccess = {
    filterVisible(actor, type, rows) {
      return resourceCatalog.authorization.filterVisibleRows(actor, type, rows)
    },
    canView(actor, type, row) {
      return resourceCatalog.authorization.canViewResource(actor, type, row)
    },
    requireEdit(actor, type, row) {
      return resourceCatalog.authorization.requireResourceEdit(actor, type, row)
    },
    requireGovern(actor, type, row) {
      return resourceCatalog.authorization.requireResourceGovern(actor, type, row)
    },
    assertNameUnchangedForEditor: resourceCatalog.authorization.assertNameUnchangedForEditor,
  }
  const developmentConfigOperations = composeDevelopmentConfigOperations(
    db,
    developmentAdapterConfigOperations,
    developmentConfigAccess,
  )
  const mcpRuntimeTestBindings = await createPausableDaemonRuntimeServiceBindings({
    runtimeId: 'mcp-runtime-tests',
    closeParticipantId: 'mcp-runtime-tests-final-close',
    service: mcpRuntimeTests,
  })

  // RFC-257 — webhook 分流器 + 三段式重启恢复：上个进程遗留的 received/
  // processing 投递标 failed/interrupted（GitLab 对失败投递不自动重试，恢复
  // 路径 = 投递历史页手动 replay——design §1.3/D23）。
  // RFC-303: orphan process/session repair above is the release proof for the
  // previous daemon. Reconcile durable launch barriers/effects before HTTP or
  // auto-resume can attach a new task driver.
  const webhookTerminalControl = composeMrTerminalControl(db)
  await webhookTerminalControl.reconcileOnBoot()
  const webhookDeliveryPersistence = composeSqliteWebhookDeliveryPersistence(db)
  const recoveredDeliveries = await recoverInterruptedDeliveries(webhookDeliveryPersistence)
  if (recoveredDeliveries > 0) {
    log.info('webhook deliveries marked interrupted', { count: recoveredDeliveries })
  }
  // RFC-310 PR-10 T104：legacy code-capability 的四个启动恢复钩子（lease 回收/
  // publish section 清理/publish intent 对账/supersede 续跑）随 writer 一并
  // 移除——Mission 面的恢复由 development-automation 的 recover sweep 承担。
  const digitalEmployeeWorkStart = createDeferredDigitalEmployeeWorkStart()
  const webhookTaskExecutions = taskExecutionProvider.trigger.taskExecutions
  const webhookDispatcher = createWebhookDispatcher({
    ...composeSqliteWebhookDispatchCore(db, secretBox, scheduledTaskRuntime.operations),
    identityAccess: integrationIdentityAccess,
    resolveEventTargetAuthority: async (userId) => {
      const admitted = await identityAccess.localOperator.forLegacyHttpUser(userId)
      if (admitted === null) return null
      return Object.freeze({
        authority: admitted.commandContext().authority,
        actor: admitted.actor,
      })
    },
    getDefaultRuntime: async () => loadConfig(Paths.config).defaultRuntime,
    terminalControl: webhookTerminalControl,
    ...createSqliteWebhookExecutionRuntime({
      taskExecutions: webhookTaskExecutions,
      digitalEmployeeWorkStart: digitalEmployeeWorkStart.participant,
    }),
  })
  const developmentApprovalGateway = composeSqliteApprovalGatewayRunner(db)
  const missionEventContinuation = createSqliteMissionCodeHostEventContinuation(db)
  const employeeWriterCutover = composeSqliteDigitalEmployeeWriterCutover(db)
  const employeeWriterState = await employeeWriterCutover.activate()
  log.info('digital employee writer activated', { ...employeeWriterState })

  // RFC-310 PR-3/PR-4 + RFC-344 —— bootstrap owns exactly one
  // development-automation composition. HTTP and MCP receive this participant;
  // boot recovery, terminal callbacks and wake sweeps drive the same instance.
  const developmentAdmissionLookup = composeSqliteDevelopmentAdmissionLookup(db)
  const developmentAutomationRef: {
    current: ReturnType<typeof composeDevelopmentAutomation> | null
  } = { current: null }
  const developmentTerminalObserver = createSqliteDevelopmentMissionExecutionTerminalObserver({
    db,
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
  const developmentAutomation = composeDevelopmentAutomation({
    db,
    appHome: Paths.root,
    admissionLookup: developmentAdmissionLookup,
    requirementSource: composeSqliteRequirementSourceRunner(db),
    changeCandidate: bindChangeCandidateParticipant(),
    candidateDelivery: bindCandidateDeliveryParticipant({
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
    ...buildDevelopmentDeliveryDeps(developmentDeliveryProvider),
    ...buildDevelopmentPipelineDeps(developmentDeliveryProvider.pipeline),
    ...buildDevelopmentMrFactsDeps(developmentDeliveryProvider),
    agentLauncher: composeAgentActionExecution({
      db,
      startDeps: buildStartTaskDeps(
        db,
        taskExecutionRuntime.schedulerDriver,
        Paths.config,
        SYSTEM_USER_ID,
        secretBox,
        identityAccess,
      ),
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.agent(executionRef)
      },
    }),
    scriptLauncher: composeScriptActionExecution({
      db,
      startDeps: buildStartTaskDeps(
        db,
        taskExecutionRuntime.schedulerDriver,
        Paths.config,
        SYSTEM_USER_ID,
        secretBox,
        identityAccess,
      ),
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.script(executionRef)
      },
    }),
    approvalGateway: developmentApprovalGateway,
  })
  developmentAutomationRef.current = developmentAutomation
  const employeeHttpEventCenter = await composeEventCenter({
    db,
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
      approval: composeDevelopmentApprovalEventObserver({
        gateway: developmentApprovalGateway,
      }),
    }),
    routingSubscriptions: createCodeHostWebhookRoutingDirectory(db, missionEventContinuation),
    automationWorkStart: {
      launch: (input) => webhookDispatcher.dispatchEventTarget(input),
    },
    deliveryConsumers: [
      createCodeHostWebhookDeliveryConsumer(db, webhookDispatcher, missionEventContinuation),
    ],
    deliveryRetryLimits: {
      current() {
        const current = loadConfig(Paths.config)
        return {
          defaultNodeRetries: current.defaultNodeRetries,
          sessionRestartBudget: current.sessionRestartBudget,
        }
      },
    },
  })
  const employeeCaseDetailProjection = composeDevelopmentEmployeeCaseDetailProjection(
    createSqliteDevelopmentEmployeeCaseWorkspaceDetailReader(db),
  )

  const gateContinuationDeps = {
    db,
    schedulerDriver: taskExecutionRuntime.schedulerDriver,
    appHome: Paths.root,
    configPath: Paths.config,
    ...(secretBox !== undefined ? { secretBox } : {}),
    ...(config.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: config.subagentLiveCapture }
      : {}),
    ...resolveLaunchRuntimeConfig(Paths.config),
  }
  const humanGateContinuationRecovery = createSqliteHumanGateContinuationRecoveryQueries(db)

  const humanGateContinuationWorkerDefinition = createHumanGateContinuationWorkerDefinition({
    listPending: () => humanGateContinuationRecovery.listPending(),
    drive: composeHumanGateContinuationDriver(gateContinuationDeps),
    onError: (continuation) => {
      log.warn('pending human-gate continuation drive failed', {
        taskId: continuation.taskId,
        continuationRef: continuation.continuationRef,
        error:
          continuation.error instanceof Error
            ? continuation.error.message
            : String(continuation.error),
      })
    },
  })
  const committedEventCodecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  const committedEventProjectors = [
    createSqliteTaskLifecycleWsProjector(db),
    createCollaborationWsProjector(createSqliteCollaborationCommittedEventProjection(db)),
  ]
  const committedEventProjectionLedger = createCommittedEventProjectionLedger()
  const committedEventPersistence = createSqliteCommittedEventDeliveryPersistence(db)
  const humanGateTerminalSweep = createSqliteHumanGateTerminalSweepCommand(db)

  const committedEventDispatcher = createCommittedEventDispatcher({
    persistence: committedEventPersistence,
    workerId: `committed-events-${DAEMON_GENERATION}`,
    codecs: committedEventCodecs,
    consumers: [
      ...createTaskLifecycleDurableConsumerDefinitions({
        events: employeeHttpEventCenter.commands,
        async closeTerminalGates(taskId, status) {
          await humanGateTerminalSweep.run({ taskId, cause: `task-${status}` })
        },
        async notifyChildBudget(taskId, status) {
          notifyChildBudgetTaskStatus(taskExecutionPersistence.childBudget, taskId, status)
        },
        async notifyExecutionWatch(taskId, status) {
          notifyTaskTerminal(taskId, status)
        },
        async nudgeWorkspacePrune(taskId) {
          if (isTaskActive(taskId)) return
          await finishClaimedWebhookWorkspacePrune(db, taskId)
        },
      }),
      ...createCollaborationDurableConsumerDefinitions({
        events: employeeHttpEventCenter.commands,
        nudgeContinuation: humanGateContinuationWorkerDefinition.nudge,
        async enqueueReviewDistill(input) {
          await memoryOperations.distillCommands.enqueue({
            sourceKind: 'review',
            sourceEventId: input.sourceEventId,
            taskId: input.taskId,
          })
        },
      }),
      ...committedEventProjectors,
    ],
    projectionLedger: committedEventProjectionLedger,
    maxAttempts() {
      const current = loadConfig(Paths.config)
      return 1 + current.defaultNodeRetries + current.sessionRestartBudget
    },
  })
  const committedEventWorkerDefinition = createCommittedEventDispatcherWorkerDefinition({
    persistence: committedEventPersistence,
    dispatcher: committedEventDispatcher,
  })
  const committedEventPump = createAfterCommitEventPump({
    persistence: committedEventPersistence,
    codecs: committedEventCodecs,
    projectors: committedEventProjectors,
    projectionLedger: committedEventProjectionLedger,
    nudgeDispatcher: committedEventWorkerDefinition.nudge,
  })
  // RFC-349 —— 与 PostgreSQL daemon 同构：post-commit 投影泵必须归 provider session 管。
  // 裸注册的泵在迁移冻结窗口内依然挂着，任何一笔漏出的提交（含 `/api/database/*`
  // 这条被有意豁免的控制面）都会让它 `publishNow` 往**源库**写投影/账本行，拷贝阶段
  // 随后以 `sqlite-source-mutated` 收场。停泵是安全的：`publishCommittedEventsAfterCommit`
  // 明确允许 pump 缺席，durable delivery 是恢复路径（`platform/events/committed/runtime.ts`）。
  const afterCommitPumpFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'after-commit-event-pump',
    start() {
      registerAfterCommitEventPump(committedEventPump)
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          registerAfterCommitEventPump(null)
        },
        drain() {
          if (!stopped) throw new Error('after-commit-event-pump-drain-before-stop')
        },
      })
    },
  })
  const humanGateContinuationRuntimeFactory = createManagedWorkerRuntimeHandleFactory({
    id: 'human-gate-continuation',
    stopReason: 'provider-session-paused',
    start() {
      const worker = startManagedWorkerDefinition(
        humanGateContinuationWorkerDefinition.definition,
        DAEMON_GENERATION,
      )
      void worker.done.catch((error) => {
        log.error('human-gate continuation worker stopped unexpectedly', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return worker
    },
  })
  const committedEventRuntimeFactory = createManagedWorkerRuntimeHandleFactory({
    id: 'committed-event-dispatcher',
    stopReason: 'provider-session-paused',
    start() {
      const worker = startManagedWorkerDefinition(
        committedEventWorkerDefinition.definition,
        DAEMON_GENERATION,
      )
      void worker.done.catch((error) => {
        log.error('committed-event dispatcher stopped unexpectedly', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return worker
    },
  })
  let intentDispatchDeps: Omit<IntentDispatchDeps, 'configSnapshot'> | null = null
  const pendingIntentSessionIds = new Set<string>()
  const resumeIntentSessions = (sessionIds: readonly string[]): void => {
    if (sessionIds.length === 0) return
    if (intentDispatchDeps === null) {
      for (const sessionId of sessionIds) pendingIntentSessionIds.add(sessionId)
      return
    }
    void resumeQueuedIntentWorkingSets(
      { ...intentDispatchDeps, configSnapshot: loadConfig(Paths.config) },
      sessionIds,
    ).catch((err) =>
      log.warn('queued intent working-set admission failed', {
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  // RFC-338 — every periodic DB/FS-heavy maintenance body runs on a dedicated
  // Worker connection. Main only admits durable slots and consumes typed
  // notification/admission deltas; Worker failure never falls back to running
  // the old body on this HTTP event loop.
  const intentMaintenanceSnapshots = composeSqliteIntentMaintenanceSnapshotQueries(db)
  const maintenanceService = startMaintenanceService({
    dbPath: Paths.db,
    migrationsFolder,
    appHome: Paths.root,
    configPath: Paths.config,
    loadConfig: () => loadConfig(Paths.config),
    payloadSources: Object.freeze({
      activeTaskIds: activeTaskIdsSnapshot,
      activeIntentApplyJournalIds: intentMaintenanceSnapshots.activeApplyJournalIds,
      activeResourceBundleApplyIds,
      bootIntentTurnIds: intentMaintenanceSnapshots.bootTurnIds,
    }),
    onLifecycleDelta: (delta) => {
      for (const alert of delta.alerts) {
        broadcastAlert(alert, alert.transition)
      }
      for (const taskId of delta.resolvedTaskIds) {
        broadcastResolved(taskId)
      }
    },
    onIntentQueued: resumeIntentSessions,
  })
  const maintenanceRuntimeBindings = await createPausableDaemonRuntimeServiceBindings({
    runtimeId: 'maintenance',
    closeParticipantId: 'maintenance-final-close',
    service: maintenanceService,
  })
  // RFC-349 T5 — compose this provider-neutral participant once at daemon
  // bootstrap. HTTP and the Digital Employee worker must not independently
  // choose or reopen a database provider.
  const employeeExecutionContracts = composeExecutionContract({
    db,
    appHome: Paths.root,
    registrations: developmentExecutionContractRegistrations,
    implicitAgentDeclarations: developmentImplicitAgentContractDeclarations,
  })
  const codeHistoryQueries = composeSqliteCodeHistoryQueries(db)
  const databaseMigration = composeDatabaseMigrationModule({
    admission: deferredDatabaseMigrationAdmission.admission,
    sqlitePath: Paths.db,
    operationsRoot: Paths.databaseMigrationsDir,
    generationPointerPath: Paths.databaseGenerationPointer,
    configPath: Paths.config,
    executionMode: 'background',
    onBackgroundFailure({ operationId, error }) {
      log.error('database migration background operation failed', {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  // 7. HTTP server.
  //
  // The authoring HTTP surface and the OS runtime must read ONE platform tool
  // catalog. `createComposedApp` composes its own digital-employee module, so a
  // catalog built later (for `employeeOs` alone) leaves every
  // `/work-items/:ref/tools` response empty and the job-template editor with no
  // built-in tool to bind.
  const digitalEmployeePlatformTools = await composeDigitalEmployeeBuiltinToolCatalog({
    agentTemplates: digitalEmployeeAgentTemplates,
    typePackageDescriptorJsons: [
      ...readPersistedDigitalEmployeeTypePackageDescriptorJsons(db),
      developmentEmployeeTypePackage.descriptorJson,
    ],
  })
  const app = createComposedApp(
    composeSqliteAppDeps({
      providerCore,
      token,
      digitalEmployeePlatformTools,
      configPath: Paths.config,
      daemonInfoPath: Paths.daemonInfo,
      // RFC-226: runtime readiness is not daemon health. Startup never executes
      // OpenCode; explicit runtime status/Test/use paths perform the version and
      // RFC-227 byte-frozen runtime admission instead.
      opencodeVersion: null,
      dbVersion,
      db,
      executionContracts: employeeExecutionContracts,
      codeHistoryQueries,
      developmentAdmissionLookup,
      identityAccess: integrationIdentityAccess,
      maintenanceStatus: maintenanceService.status,
      secretBox,
      repositoryPublicationTransport,
      developmentAutomation,
      schedulerDriver: taskExecutionRuntime.schedulerDriver,
      taskExecutionReadModels: taskExecutionRuntime.readModels,
      taskRouteLaunch: taskExecutionProvider.routeLaunch,
      memoryOperations,
      databaseMigration: databaseMigration,
      collaborationContext,
      mcpRuntimeTests,
      webhookDispatcher,
      webhookTerminalControl,
      digitalEmployeeEventCenter: employeeHttpEventCenter,
      digitalEmployeeCaseDetailProjection: employeeCaseDetailProjection,
      digitalEmployeeWorkStart,
      digitalEmployeeTypePackageDriftPolicy,
    }),
  )

  const bindHost = opts.host ?? config.bindHost
  const bindPort = opts.port ?? config.bindPort ?? 0
  const ws = buildWebSocketAdapter({
    daemonToken: token,
    realtime: providerCore.realtime,
    identityAccess,
  })

  // 7b. RFC-170 §invariant④ (T-BOOT): AFTER HTTP opens, re-verify every managed
  //     snapshot's integrity in the background (re-hash vs content_hash). A durable
  //     'snapshot-authoritative' flag can't prove the snapshot didn't corrupt
  //     offline (G6-4), so this pass gates availability THIS boot: passing skills
  //     enter the in-memory bootVerifiedSet (injectable/visible), corrupt ones are
  //     quarantined. Runs after serving starts (no boot barrier — a big legit tree
  //     is just "available later"); best-effort, never crashes the daemon.
  void (async () => {
    try {
      // RFC-170 T4a: first, lazily backfill a v1 snapshot for any legacy managed
      // skill created before version tracking (version_state='legacy-unbackfilled',
      // no skill_versions row) — else the availability gate would hide it after an
      // upgrade — and sweep orphaned husk rows (no files, no versions) that would
      // otherwise squat their name invisibly forever. Per-skill best-effort; see
      // backfillLegacySkillVersions.
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

  // 8. Background loops. RFC-338 owns every DB/FS-heavy maintenance cadence;
  // limits and the in-memory batch-import Map remain lightweight on main.
  //
  // All four are provider-session handles, not free-running tickers: a database
  // migration freezes the SQLite source and then proves it did not move
  // (`sqliteLogicalSource.assertUnchanged`). A writer that is not registered here
  // keeps running straight through that freeze — the 1Hz limit enforcer above
  // all — and the copy fails with `sqlite-source-mutated` having named nothing.
  // The PostgreSQL daemon already composes the same four as pausable handles;
  // this is the SQLite side of that symmetry.
  const limitsRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'resource-limits',
    intervalMs: DAEMON_CADENCE.resourceLimits,
    run: () => enforceLimits(composeLegacySqliteResourceLimitOperations(db)).then(() => undefined),
    onError(error) {
      log.error('enforceLimits failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  // RFC-350 —— 不活跃超时收割（僵尸任务），DEFAULT OFF。同样是 provider-session
  // handle：它会 cancel 任务并杀进程，绝不能在迁移冻结窗口里跑（AC-15）。留在主线程
  // 而不是进 RFC-338 的维护 Worker，因为 cancelTask 依赖进程内 scheduler 的
  // AbortController / driver stop ticket / WS 广播，Worker 线程拿不到。
  const idleTimeoutOperations = composeTaskIdleTimeoutOperations({
    persistence: createSqliteTaskIdleTimeoutPersistence(db),
    cancelTask: async (taskId: string) => {
      const { cancelTask } = await import('@/services/task')
      await cancelTask(db, taskId)
    },
  })
  const idleTimeoutRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'task-idle-timeout',
    intervalMs: DAEMON_CADENCE.taskIdleTimeout,
    // 每拍热读配置：开关与阈值改动免重启（AC-16）。
    run: () =>
      runTaskIdleTimeoutSweep(idleTimeoutOperations, loadConfig(Paths.config).taskIdleTimeout).then(
        () => undefined,
      ),
    onError(error) {
      log.error('task idle-timeout sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  // Scheduled backup creation keeps its own cadence; retention is admitted to
  // the maintenance Worker both by the configured heavy schedule and after a
  // backup settles.
  const backupRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'scheduled-backup',
    start() {
      const current = loadConfig(Paths.config)
      const ticker = startBackupScheduler({
        db,
        intervalMs: current.backupIntervalMs,
        retentionCount: current.backupRetentionCount,
        retentionDays: current.backupRetentionDays,
        maxTotalBytes: current.backupMaxTotalBytes,
        protectedKeepCount: current.backupProtectedKeepCount,
        // 每拍热读:改了设置不必重启(实现门 P1-5)。
        loadRetention: () => {
          const cfg = loadConfig(Paths.config)
          return {
            retentionCount: cfg.backupRetentionCount,
            retentionDays: cfg.backupRetentionDays,
            maxTotalBytes: cfg.backupMaxTotalBytes,
            protectedKeepCount: cfg.backupProtectedKeepCount,
          }
        },
        appHome: Paths.root,
        pruneMode: 'external',
        onBackupSettled: () => maintenanceService.runSoon('backupPrune'),
      })
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('scheduled-backup-drain-before-stop')
        },
      })
    },
  })
  // RFC-210 G7: keep cached mirrors (and their submodules) from going stale when
  // nobody launches a task against them. Reads its own enable flag each tick.
  const submoduleRefreshRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'submodule-refresh',
    start() {
      const ticker = startSubmoduleRefreshLoop(
        repositoryWorkspaceStore,
        () => loadConfig(Paths.config),
        undefined,
        Paths.root,
        secretBox,
      )
      const unregister = registerConfigAppliedListener(Paths.config, () => ticker.reconfigure())
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          unregister()
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('submodule-refresh-drain-before-stop')
        },
      })
    },
  })
  const batchImportRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'batch-import-gc',
    start() {
      const ticker = startBatchImportGc(
        undefined,
        loadConfig(Paths.config).repoBatchImportRetentionMs,
      )
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('batch-import-gc-drain-before-stop')
        },
      })
    },
  })
  // RFC-050: register an ambient provider so enqueueDistillJob callers
  // pick up the current `config.memoryDistillLang` without us having to
  // thread configPath through review.ts / clarify.ts / taskFeedback.ts.
  // Re-reads config on every call so admin edits to the config file
  // (e.g. via `PUT /api/config`) flow through without a daemon restart.
  setMemoryDistillLangProvider(() => {
    try {
      return loadConfig(Paths.config).memoryDistillLang ?? null
    } catch {
      return null
    }
  })

  // 引导期快照。distill 的这几项此前就是启动时读一次（改了要重启），本次只是把它
  // 从 batch-import 那条共用的 `loadConfig` 上摘下来，行为逐字不变。
  const distillBootConfig = loadConfig(Paths.config)
  // RFC-041 — the provider session owns the distill loop. Stopping prevents a
  // new claim and draining waits for the exact in-flight LLM turn before the
  // selected provider can close.
  const memoryDistillRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'memory-distill',
    intervalMs: 1_000,
    beforeStart: async () => {
      await memoryOperations.distillWorker.recoverRunning()
    },
    async run() {
      if (distillBootConfig.memoryDistillerEnabled === false) return
      await memoryOperations.distillWorker.tick({
        runtimeName: distillBootConfig.memoryDistillRuntime ?? null,
        defaultRuntime: distillBootConfig.defaultRuntime ?? null,
        model: distillBootConfig.memoryDistillModel ?? null,
        sourceContextBudget: distillBootConfig.memoryDistillSourceContext,
      })
    },
    onError(err) {
      log.warn('memory distill tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    },
  })
  // Intent/apply/resource-bundle boot convergence is admitted by
  // maintenanceService and executes off-thread; typed queued-session deltas
  // above are the only work handed back to main.
  // This recovery/driver section consumes the bootstrap-owned participant
  // above; routes never assemble a second daemon instance.
  if (
    employeeWriterState.mode === 'legacy-draining' ||
    employeeWriterState.legacyAdmissionsEnabled
  ) {
    try {
      const recovered = await developmentAutomation.recover()
      if (
        recovered.settledFences > 0 ||
        recovered.invalidatedEffects > 0 ||
        recovered.firedWakes > 0
      ) {
        log.info('draining legacy development mission recovery on boot', recovered)
      }
    } catch (err) {
      log.warn('legacy development mission boot recovery failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const developmentWakeRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'development-wake',
    intervalMs: DAEMON_CADENCE.developmentWakeSweep,
    async run() {
      const writer = await employeeWriterCutover.refresh()
      if (writer.mode === 'os-active' && !writer.legacyAdmissionsEnabled) return
      await developmentAutomation.sweepWakes()
    },
    onError(err) {
      // This correctness sweep shares the foreground connection with HTTP.
      // A bounded maintenance write may own SQLite briefly; keep the daemon
      // alive and retry on the next cadence instead of leaking BUSY from the
      // timer callback as an uncaught process-level exception.
      log.warn('development writer refresh failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    },
  })
  // Upload/input/retention sweeps are direct RFC-338 Worker adapters. The
  // development wake driver remains a separate 30s correctness loop.

  // RFC-310 OS runtime: the HTTP composition is intentionally stateless and
  // may be recreated by tests; the daemon owns the one durable driver that
  // gives Event Center, Case outbox/queue, Reaction planning and TaskEngine
  // settlement bounded turns. All business state and leases remain in SQLite.
  const employeeInputArtifacts = createEmployeeInputArtifactStore(
    join(Paths.root, 'artifacts', 'employee-inputs'),
  )
  const employeeWorkspace = composeSqliteDevelopmentEmployeeWorkspace({
    db,
    appHome: Paths.root,
    reactionRounds: createEmployeeReactionRoundQueries(db),
    inputArtifacts: employeeInputArtifacts,
    repositoryPreparation: buildDevelopmentWorkspaceRepositoryPreparation(
      developmentWorkspaceRepositoryPreparation,
    ),
    sourceControl: bindEmployeeCaseWorkspaceParticipant({
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
  })
  const employeeEventCenter = employeeHttpEventCenter
  const employeeDelivery = buildDevelopmentDeliveryDeps(developmentDeliveryProvider)
  const employeeOs = composeDigitalEmployee({
    db,
    appHome: Paths.root,
    typePackages: [developmentEmployeeTypePackage],
    typePackageDriftPolicy: digitalEmployeeTypePackageDriftPolicy,
    platformTools: digitalEmployeePlatformTools,
    onAutomaticUpgradeIssue: (issue) => {
      log.warn('automatic digital employee type upgrade could not prove compatibility', {
        ...issue,
      })
    },
    executionContracts: employeeExecutionContracts,
    retryLimits: {
      current() {
        const config = loadConfig(Paths.config)
        return {
          defaultNodeRetries: config.defaultNodeRetries,
          sessionRestartBudget: config.sessionRestartBudget,
        }
      },
    },
    inputArtifacts: employeeInputArtifacts,
    connectionCatalog: composeSqliteDevelopmentToolConnectionCatalog(db),
    runtime: {
      eventCenter: employeeEventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      detailProjectionParticipants: [employeeCaseDetailProjection],
      execution: createReactionExecutionAdapter(
        composeDigitalEmployeeExecution({
          db,
          appHome: Paths.root,
          startDeps: buildStartTaskDeps(
            db,
            taskExecutionRuntime.schedulerDriver,
            Paths.config,
            SYSTEM_USER_ID,
            secretBox,
            identityAccess,
          ),
          workspace: employeeWorkspace,
          executionContracts: employeeExecutionContracts,
        }),
      ),
      platformWorkItems: composeSqliteDevelopmentEmployeePlatformWorkItems({
        reactionRounds: createEmployeeReactionRoundQueries(db),
        db,
        appHome: Paths.root,
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
      }),
    },
  })
  await employeeOs.maintenance.settleAutomaticUpgrades()
  const intentAuthorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
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
      agents: agentCatalog.queries,
      skills: skillCatalog.queries,
      skillFiles: skillCatalog.fileQueries,
      mcps: mcpCatalog.queries,
      plugins: pluginCatalog.queries,
      workflows: workflowCatalog.queries,
      workgroups: workgroupCatalog.queries,
    },
  })
  // Context mutations authorize each added resource INSIDE their transaction, so
  // the daemon needs the authorized runner — the same one `createComposedApp` and
  // the PostgreSQL daemon compose. With the plain runner every activation that
  // adds a resource dies on `intent-context-authorization-not-composed`, which is
  // how boot recovery silently failed every queued working-context successor.
  const intentPersistence = composeSqliteIntentPersistence({
    db,
    contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
  })
  const intentPlatformInventory = composeIntentPlatformInventoryParticipant({
    authorityFor: intentAuthorityFor,
    capabilityTemplates: capabilityTemplateOperations,
    developmentConfig: developmentConfigOperations,
    digitalEmployee: composeDigitalEmployeePlatformInventoryParticipant({
      queries: employeeOs.queries,
      access: resourceCatalog.authorization,
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
          loadConfig(Paths.config).defaultRuntime ?? 'opencode',
        )
        return { name: runtime.name, protocol: runtime.protocol }
      },
    }),
  })
  intentDispatchDeps = Object.freeze({
    persistence: intentPersistence,
    identityAccess: Object.freeze({ directAuthority: identityAccess.directAuthority }),
    appHome: Paths.root,
    runtimeResolver: composeIntentTurnRuntimeResolver(intentPersistence),
    dumpAuxiliary: intentDumpAuxiliary,
    resourceCatalogFor: intentResourceCatalogFor,
  })
  const queuedBeforeIntentComposition = [...pendingIntentSessionIds]
  pendingIntentSessionIds.clear()
  resumeIntentSessions(queuedBeforeIntentComposition)
  if (employeeOs.runtime === null) {
    throw new Error('digital employee runtime composition unexpectedly unavailable')
  }
  const employeeOsRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'digital-employee-os',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      const result = await runDigitalEmployeeOsCycle({ runtime: employeeOs.runtime!.worker })
      if (result.steps >= 32) {
        log.warn('digital employee OS cycle reached its bounded step budget', { ...result })
      }
    },
    onError(err) {
      log.warn('digital employee OS cycle failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    },
  })
  const eventCenterRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'event-center',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      const result = await runEventCenterCycle(employeeEventCenter.worker)
      if (result.steps >= 32) {
        log.warn('event center cycle reached its bounded step budget', { ...result })
      }
    },
    onError(err) {
      log.warn('event center cycle failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    },
  })
  // Employee input, intent cleanup/recovery, token audit, lifecycle invariants
  // and stuck detection are all admitted by maintenanceService. Lifecycle
  // notifications return through its typed delta callback above.

  // RFC-101: settle running fusions (engine task done → awaiting_approval) so
  // the inbox badge lights up without a client poll.
  const fusionReconcileRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'fusion-reconcile',
    intervalMs: DAEMON_CADENCE.fusionReconcile,
    async run() {
      await reconcileRunningFusions({ operations: fusionOperations, appHome: Paths.root })
    },
    onError() {
      // Reconciliation is best-effort; the next provider-owned tick retries.
    },
  })
  // TaskExecution owns all four provider-bound periodic writers and the one
  // boot auto-resume attempt. Its reversible background aggregate is also the
  // exact provider-session drain boundary used during database cutover.
  const taskExecutionBackgroundBindings = await _bindTaskExecutionProviderBackground(
    taskExecutionProvider.background,
    {
      configPath: Paths.config,
      scheduled: {
        operations: scheduledTaskRuntime.operations,
        identityAccess: integrationIdentityAccess,
        loadConfig: () => loadConfig(Paths.config),
      },
    },
  )
  const providerRuntimeFactories = Object.freeze([
    taskExecutionBackgroundBindings.runtimeFactory,
    maintenanceRuntimeBindings.runtimeFactory,
    mcpRuntimeTestBindings.runtimeFactory,
  ] satisfies readonly DaemonProviderRuntimeHandleFactory[])
  // RFC-349 — the MR terminal-control worker owns an interval timer and a
  // fire-and-forget drain against the SQLite client. A migration freeze must
  // stop it before `selectDatabaseSchemaProvider('postgresql')` re-points the
  // shared table projection, otherwise its next tick prepares
  // `agent_workflow.webhook_mr_launch_guards` on bun:sqlite and the daemon dies
  // mid-cutover. Registering it as a provider handle (not only as a close
  // participant) is what puts it inside the pause/resume fence.
  const webhookTerminalControlRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'webhook-terminal-control',
    start() {
      // Boot already armed the worker through `reconcileOnBoot`; this call only
      // matters on the rollback path, where the frozen source session takes its
      // own writers back after a failed cutover.
      webhookTerminalControl.resume()
      let stopping: Promise<void> | null = null
      return Object.freeze({
        stop() {
          stopping ??= webhookTerminalControl.stop()
          return stopping
        },
        async drain() {
          if (stopping === null) throw new Error('webhook-terminal-control-drain-before-stop')
          await stopping
        },
      })
    },
  })
  const providerBackgroundWriterFactories = Object.freeze([
    webhookTerminalControlRuntimeFactory,
    afterCommitPumpFactory,
    limitsRuntimeFactory,
    idleTimeoutRuntimeFactory,
    backupRuntimeFactory,
    submoduleRefreshRuntimeFactory,
    batchImportRuntimeFactory,
    humanGateContinuationRuntimeFactory,
    committedEventRuntimeFactory,
    memoryDistillRuntimeFactory,
    developmentWakeRuntimeFactory,
    employeeOsRuntimeFactory,
    eventCenterRuntimeFactory,
    fusionReconcileRuntimeFactory,
  ] satisfies readonly DaemonProviderRuntimeHandleFactory[])
  const providerCloseParticipants = Object.freeze([
    taskExecutionBackgroundBindings.closeParticipant,
    maintenanceRuntimeBindings.closeParticipant,
    mcpRuntimeTestBindings.closeParticipant,
  ] satisfies readonly DaemonProviderCloseParticipant[])
  const initialProviderSession = await _createComposedDaemonProviderRuntimeSession({
    provider: 'sqlite',
    generationId: providerSessionLifecycle.generationId,
    app,
    webSocket: ws,
    runtimeFactories: providerRuntimeFactories,
    backgroundWriterFactories: providerBackgroundWriterFactories,
    providerCloseParticipants,
    shutdownIdentity: () => identityAccess.shutdown(),
    closeProvider: () => databaseProvider.close(),
  })
  const daemonProviderBootstrap = createDaemonProviderBootstrap({
    initialSession: initialProviderSession,
    sessionFactory: {
      async create(input) {
        if (input.provider === 'sqlite') {
          throw new Error('sqlite-provider-session-source-retired')
        }
        const nextConfig = loadConfig(Paths.config)
        const nextProvider = resolveDatabaseProviderRuntime({
          config: nextConfig.database,
          sqlitePath: Paths.db,
          generationPointerPath: Paths.databaseGenerationPointer,
          operationsRoot: Paths.databaseMigrationsDir,
          contract: logicalSchemaContract,
        })
        if (
          nextProvider.provider !== 'postgresql' ||
          nextProvider.generation.payload.generationId !== input.generationId
        ) {
          await nextProvider.close()
          throw new Error('postgresql-daemon-target-generation-mismatch')
        }
        return (
          await composePostgresqlProviderSession({
            provider: nextProvider,
            config: requirePostgresqlConfig(nextConfig),
            token,
            secretBox,
            dbVersion,
            migrationAdmission: deferredDatabaseMigrationAdmission.admission,
            sourceWriteWindow: deferredDatabaseMigrationAdmission.sourceWriteWindow,
            log,
          })
        ).session
      },
    },
    createMigrationAdmission: createDatabaseMigrationDaemonAdmission,
    // RFC-349 —— 表投影是**进程级**的：`createPostgresqlDatabaseClient` 一构造就把
    // 它改指到 PostgreSQL。割接失败时 current 会退回源 session，但投影不会自己退
    // 回来，于是整个 daemon 的每一条 SQLite 查询都会以
    // `no such table: agent_workflow.*` 收场。把选择权钉在**真正在服务的**那份
    // composition 上，成功与失败两条路径都对。
    onCurrentSelected: (session) => selectDatabaseSchemaProvider(session.provider),
  })
  deferredDatabaseMigrationAdmission.bind(daemonProviderBootstrap)
  await initialProviderSession.resume(providerSessionLifecycle)

  const server = Bun.serve({
    port: bindPort,
    hostname: bindHost,
    // Bun's default idle timeout is too short for bounded package installs.
    idleTimeout: 255,
    async fetch(req: Request, srv): Promise<Response> {
      return await daemonProviderBootstrap.runBusinessRequest(req, async () => {
        const upgraded = await daemonProviderBootstrap.tryUpgrade(req, srv)
        if (upgraded === true) return undefined as unknown as Response
        if (upgraded === false) return await daemonProviderBootstrap.fetch(req)
        return upgraded
      })
    },
    websocket: daemonProviderBootstrap.websocketHandlers,
  })
  const baseUrl = `http://${server.hostname}:${server.port}/`
  log.info('listening', { url: baseUrl })

  // 9. Graceful shutdown (P-4-06).
  //
  // SIGTERM/SIGINT:
  //   - stop accepting new HTTP requests
  //   - abort all running tasks (their AbortControllers SIGTERM their child
  //     opencode processes via runner.ts; the scheduler then marks rows
  //     canceled/interrupted)
  //   - poll for ~30s; any task still in 'running' after the budget is
  //     flipped to 'interrupted' so the next daemon start surfaces it as
  //     daemon-restart instead of leaving stale rows.
  //
  // CRITICAL: signal handlers must be installed BEFORE the "ready" line is
  // printed to stdout. The test/launcher races: it reads the URL from stdout
  // and immediately sends SIGTERM — if the handler hasn't been registered
  // yet, Node's default terminate runs and `.daemon.info` outlives us.
  const removeDaemonInfo = (): void => {
    try {
      unlinkSync(Paths.daemonInfo)
    } catch {
      // already removed or never written
    }
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    await memoryOperations.distillWorker.recoverRunning()
    registerAfterCommitEventPump(null)
    await webhookTerminalControl.stop()
    removeDaemonInfo()
    server.stop(true)
    try {
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(
        {
          controller: { shutdownActive: shutdownActiveTaskExecutions },
          operations: taskExecutionPersistence.shutdown,
          recovery: taskExecutionPersistence.recoveryAdministration,
        },
        30_000,
      )
    } catch (err) {
      log.warn('graceful shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // Every provider-bound task mutation/recovery path above must settle while
    // the selected client and authority runtime are still live. Identity owns
    // no database close; the provider is deliberately the last session
    // resource released after HTTP admission and all writers have drained.
    try {
      await daemonProviderBootstrap.stop()
    } catch (error) {
      // A shutdown request has already fenced HTTP/WS admission, stopped the
      // listener, and drained task execution above. Provider close failures are
      // diagnostics for this retiring process; they must not turn a successful
      // dev-generation handoff into exit 1 and strand the replacement behind
      // the still-owned PID lock. PostgreSQL follows the same best-effort
      // terminal-close contract in servePostgresqlDaemon.
      log.warn('SQLite daemon shutdown error', {
        error: describeDaemonProviderSessionFailure(error),
      })
    }
    // `stop` treats lock disappearance as the terminal acknowledgement. Retract
    // the loopback control endpoint first, otherwise the caller can observe a
    // successful stop while the previous process's control file still exists.
    controlListener.close()
    lock.release()
    process.exit(0)
  }
  // RFC-254 T7 — the same graceful request over a transport Windows has.
  //
  // Node accepts the NAME `SIGTERM` on Windows without throwing, but delivers
  // `TerminateProcess`: a hard kill, mid-write, with no drain. So `stop` there
  // asks over loopback instead, and this is what answers. POSIX keeps the
  // signal path byte-for-byte; the listener is simply a second door to the
  // SAME `shutdown()`.
  const controlListener = startControlListener({
    controlFilePath: Paths.controlFile,
    devWatch: devLockHandoffMs() > 0,
    onShutdown: () => {
      removeDaemonInfo()
      void shutdown('control-shutdown')
    },
  })
  process.on('SIGTERM', () => {
    // unlink synchronously the instant the signal fires; the async shutdown
    // continues in the background.
    removeDaemonInfo()
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    removeDaemonInfo()
    void shutdown('SIGINT')
  })
  // Belt-and-suspenders for paths the signal handlers can't reach (uncaught
  // exception, explicit process.exit elsewhere). on('exit') is synchronous
  // and runs on every normal termination path.
  process.on('exit', () => {
    removeDaemonInfo()
    // The nonce must not outlive the process that minted it: a stale control
    // file is a secret on disk that authorizes nothing, and the next start
    // would have to reason about which of two files is current.
    controlListener.close()
    lock.release()
  })

  // Write runtime info file for `status` / `stop` subcommands to discover us.
  // Must be AFTER signal handlers so a racing SIGTERM never leaves the file
  // behind.
  writeFileSync(
    Paths.daemonInfo,
    JSON.stringify(
      {
        pid: lock.pid,
        host: server.hostname,
        port: server.port,
        url: baseUrl,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  // RFC-221 — the daemon token is only a first-admin bootstrap credential.
  // Once handoff commits, never print it as a browser login URL again.
  const browserUrl = readyBrowserUrl(
    baseUrl,
    token,
    await providerCore.authRuntime.isBootstrapRequired(),
  )
  process.stdout.write(
    `\nagent-workflow ready — open this URL in your browser:\n  ${browserUrl}\n\n`,
  )

  await new Promise<void>(() => {
    /* never resolves */
  })
}

export function readyBrowserUrl(
  baseUrl: string,
  token: string,
  bootstrapRequired: boolean,
): string {
  return bootstrapRequired ? `${baseUrl}?token=${token}` : baseUrl
}
