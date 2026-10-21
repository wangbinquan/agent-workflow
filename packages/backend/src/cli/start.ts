import { composeDaemonIntentModules } from './daemonModules/intent'
import { composeDaemonDigitalEmployeeModules } from './daemonModules/digitalEmployee'
import { composeDaemonDevelopmentAutomationModules } from './daemonModules/developmentAutomation'
import {
  composeDaemonTaskExecutionModules,
  type DaemonTaskExecutionModules,
} from './daemonModules/taskExecution'
import { DAEMON_TASK_EXECUTION_ADAPTERS } from './daemonModules/adapters'
import { createEventAutomationDelegatedContextBinding } from '@/modules/identity-access/composition'
import { composeDaemonScheduledTaskModules } from '@/cli/daemonModules/scheduledTasks'
import { composeDaemonIntegrationModules } from '@/cli/daemonModules/integration'
import { composeDaemonFusionModules } from '@/cli/daemonModules/fusion'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  standaloneModuleAdapters,
} from '@/cli/daemonModules/adapters'
import { composeDaemonMemoryModules } from '@/cli/daemonModules/memory'
import { composeDaemonObservationModules } from '@/cli/daemonModules/observation'
import { composeDaemonProviderCore } from '@/cli/daemonModules/providerCore'
import { composeDaemonRepositoryCredentials } from '@/cli/daemonModules/repositoryCredentials'
import { composeDaemonResourceCatalogModules } from '@/cli/daemonModules/resourceCatalog'
import {
  taskExecutionModule,
  createTaskExecutionShutdownController,
} from '@/modules/task-execution/composition'
import {
  composeDaemonLifecycle,
  NotApplicable,
  type DaemonLifecycle,
} from './daemonLifecycleProgram'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import type { HumanGateArtifactRecovery } from '@/modules/collaboration/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/composition'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/composition'
import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { composeDevelopmentPurposeRoot, type DevelopmentPurposeSelection } from '@/server'
import type { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
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
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import type {
  PortArtifactContentEffects,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import type {
  NodeRunPromptContentEffects,
  TaskDeletionEffects,
} from '@/modules/task-execution/public/types'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
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
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
// `agent-workflow start` — daemon foreground entry.

import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { createSecretBox, type SecretBox } from '@/auth/secretBox'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import type { CredentialAdapterSelection } from '@/modules/identity-access/composition/authentication'
import { createExecutionExitRequests } from './executionActivation'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import { ensureTokenFile } from '@/auth/token'
import type { loadConfig } from '@/config'
// RFC-366: the stored budget may carry only the RFC-044 pair; the resolver is the
// single place the newer per-source caps get their defaults.
import {
  DAEMON_SHUTDOWN_ABORT_REASON,
  DEFAULT_DISTILL_POLICY,
  resolveDistillPolicy,
  resolveSourceContextBudget,
} from '@agent-workflow/shared'

import { recoverInterruptedDeliveries } from '@/services/webhook/deliveryStore'
import {
  type EvidenceDocumentCommands,
  type EvidenceArtifactPort,
  type AttemptContextStorePort,
} from '@/modules/development-automation/composition'

import {
  cleanupOrphanedGitCredentialLeases,
  reconcileRepositoryTransportConnectionProjections,
} from '@/modules/source-control/composition'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
import {
  type TaskExecutionBackgroundControl,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'

import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'

import { DbSchemaDriftError, formatSchemaDifference } from '@/db/schemaAdmission'
import { IS_EMBEDDED } from '@/embed'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { composeSqliteAppDeps, createComposedApp, type SqliteAppComposition } from '@/server'
import { reconcileRunningFusions } from '@/modules/knowledge-evolution/public/operations'
import { composeLegacySqliteResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import {
  createDaemonRecoveryAuthorityProof,
  runTaskExecutionBootRecovery,
  type BootExecutionRecoveryFactory,
} from '@/modules/task-execution/composition/bootRecovery'
import { selectLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { activeTaskIdsSnapshot } from '@/services/task'
import {
  composeTaskIdleTimeoutOperations,
  createSqliteTaskIdleTimeoutPersistence,
  runTaskIdleTimeoutSweep,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import { recoverInterruptedTaskDeletes } from '@/services/taskDelete'
import { startConfiguredSubmoduleRefreshLoop } from '@/services/submoduleRefresh'
import { materializingSpaces } from '@/services/gc'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { startBackupScheduler, maybePreMigrationBackup } from '@/services/backupScheduler'
import {
  composeDaemonHostApplication,
  composeDaemonStartupLease,
  readDaemonStartupRecoveryAuthority,
  runDaemonStartupWithLease,
  type DaemonStartupLease,
  type DaemonStartupLeasePort,
  type DaemonDatabasePreOpenRecoveryPort,
  prepareDatabasePreOpenRecovery,
  composeLocalExecutionAuthority,
} from '@/modules/system-operations/composition'
import {
  prepareDaemonDatabaseProviderForBoot,
  type DaemonDatabaseInstallationPort,
} from '@/modules/system-operations/composition/daemonDatabase'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { composeWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { startBatchImportGc } from '@/services/repoBatchImport'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import { type PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import { detectGitCapabilities, mergeTreeGateError, MIN_GIT_VERSION } from '@/services/gitVersion'
import { setMemoryDistillPolicyProvider } from '@/modules/memory/composition'
import {
  PRESENCE_CHANNEL,
  presenceBroadcaster,
  tasksListBroadcaster,
  TASKS_LIST_CHANNEL,
} from '@/ws/broadcaster'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { getRuntimeDriver, RUNTIME_KINDS } from '@/services/runtime'
import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'
import { Paths } from '@/util/paths'
import { buildWebSocketAdapter } from '@/ws/server'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { createMaintenanceService } from '@/platform/background/maintenanceService'

import {
  runEventCenterCycle,
  type CustomObserverProgramFactory,
} from '@/modules/event-center/composition'

import { runDigitalEmployeeOsCycle } from '@/modules/digital-employee/composition'

import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { composeDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/composition/committedEvents'
import {
  combineCommittedEventCodecRegistries,
  createCommittedEventDispatcher,
} from '@/platform/events/committed/dispatcherWorker'
import {
  createCollaborationDurableConsumerDefinitions,
  createCollaborationWsProjector,
  createCollaborationCommittedEventProjection,
  collaborationCommittedEventCodec,
  createHumanGateContinuationWorkerDefinition,
} from '@/modules/collaboration/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { createCommittedEventProjectionLedger } from '@/platform/events/committed/types'
import {
  createCommittedEventDispatcherWorkerDefinition,
  startManagedWorkerDefinition,
} from '@/platform/events/committed/workerDefinitions'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { notifyChildBudgetTaskStatus } from '@/services/execution/childBudget'
import { notifyTaskTerminal } from '@/services/execution/executionWatch'

import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import {
  requireDatabaseConfig,
  requireDatabaseProviderRuntime,
  resolveDatabaseProviderRuntime,
  type ResolvedDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { composeDaemonRealtimePolicy } from './daemonRealtimePolicy'

import {
  createSqliteHumanGateContinuationRecoveryQueries,
  createSqliteHumanGateTerminalSweepCommand,
} from '@/modules/collaboration/composition'

import { readCommittedReviewArtifactBody } from '@/modules/collaboration/public/queries'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { createDatabaseMigrationDaemonAdmission } from '@/modules/system-operations/composition'
import {
  composeDaemonProviderBootstrap,
  type DaemonProviderBootstrap,
} from './daemonProviderBootstrap'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderCloseParticipant,
  type DaemonProviderRuntimeAdmission,
  type DaemonProviderRuntimeHandleFactory,
} from './daemonProviderRuntimeSession'
import {
  describeDaemonProviderSessionFailure,
  type DaemonProviderSessionLifecycleInput,
} from './daemonProviderSession'
import {
  createLazyPausableDaemonRuntimeServiceBindings,
  createManagedWorkerRuntimeHandleFactory,
  createPollingDaemonRuntimeHandleFactory,
  createSignalledDaemonRuntimeHandleFactory,
  type SignalledDaemonRuntimeOwner,
} from './daemonProviderRuntimeHandles'
import {
  composePostgresqlDaemonApplication,
  type PostgresqlDaemonApplication,
} from './postgresqlDaemonApplication'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import type { MaintenanceWorkerEffectsDescriptor } from '@/platform/background/maintenanceWorkerEffects'
import type {
  EmployeeCaseWorkspaceEffectsFactory,
  RepositoryRemoteEffects,
  WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import type {
  ResourcePackageSkillArtifactOwner,
  ResourcePackagePluginArtifactOwner,
  SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import {
  createPostgresqlHumanGateContinuationRecoveryQueries,
  createPostgresqlHumanGateTerminalSweepCommand,
} from '@/modules/collaboration/composition'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { isDbSnapshotInProgress } from '@/platform/persistence/sqlite/systemProviderBackup'
import { openSqliteMaintenanceAdmissionStore } from '@/platform/persistence/sqlite/maintenanceAdmissionStore'
import { enforceLimits } from '@/services/limits'
import {
  initializeRuntimeRegistryBoot,
  composeFileRuntimeLegacyConfiguration,
  type RuntimeLegacyConfigurationPort,
} from '@/modules/runtime-management/composition/runtimeRegistry'

import type { MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import { type SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { ScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import type { ActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionRunners'
import type { CodeReviewArtifactStore } from '@/modules/code-capability/public/participants'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import {
  selectDaemonHostLifecycle,
  type DaemonHostLifecyclePort,
} from '@/modules/system-operations/composition/daemonHostLifecycle'
import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'

import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
} from '@/modules/source-control/public/queries'

export interface StartOptions {
  port?: number
  host?: string
  /** Process-local preparation shared only by the development hot reloader. */
  developmentIntegrity?: { validatedDatabase?: string }
  configuration?: ApplicationConfigurationQueries
  applicationConfiguration?: ApplicationConfigurationBinding
  runtimeLegacyConfiguration?: RuntimeLegacyConfigurationPort
  databasePreOpenRecovery?: DaemonDatabasePreOpenRecoveryPort
  databaseInstallation?: DaemonDatabaseInstallationPort
  taskArchive?: TaskArchiveContentBinding
  skillContent?: SkillContentBinding
  employeePrograms?: ProgramArtifactPort
  /** RFC-370 §10 V19: where a program tool's contract fixture runs (hosted only). */
  programFixtureProcess?: ScriptFixtureProcess
  /** RFC-370 §10 V18: entry checks below a hosted action workspace (hosted only). */
  actionWorkspaceEntries?: ActionWorkspaceEntries
  /** RFC-370 §10 V16: code-review reads of hosted task volumes (hosted only). */
  repositoryRevisionContent?: RepositoryRevisionContentFactory
  /** RFC-370 §10 V16: code-review artifacts as object publications (hosted only). */
  codeReviewArtifacts?: CodeReviewArtifactStore
  employeeInputArtifacts?: EmployeeInputArtifactPort
  missionInputBlobs?: MissionInputBlobPersistence
  pluginInstaller?: PluginInstallerPort
  beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  humanGateArtifactRecovery?: HumanGateArtifactRecovery
  databaseBackup?: DatabaseBackupEffects
  archivedNodeEvents?: TaskArchivedEventsReader
  crewStationEvents?: CrewStationEventIngress
  intentArtifacts?: IntentArtifactSelection
  evidenceArtifacts?: EvidenceArtifactPort
  resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  resourcePackageSkillContent?: SkillPackageContentReader
  workspaceContent?: WorkspaceContentEffectsFactory
  /** RFC-370 §10 V17: hosted repository remote reads; absent, local mirrors. */
  repositoryRemote?: RepositoryRemoteEffects
  workspaceUploads?: WorkspaceUploadContentFactory
  isolationWorkspaces?: IsolationWorkspaceFactory
  repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  workspaceReads?: RepositoryWorkspaceReadQueries
  employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  repositoryBaselines?: RepositoryBaselineEffectsFactory
  verificationCommands?: VerificationCommandEffectsFactory
  customObserverPrograms?: CustomObserverProgramFactory
  bootExecutionRecovery?: BootExecutionRecoveryFactory
  automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  actionWorkspaceEffects?: ActionWorkspaceEffects
  conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  taskDeletionEffects?: TaskDeletionEffects
  /** RFC-370 §9.2 V3 — hosted only: publication network Git in the task volume. */
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  taskRunSelection?: TaskRunRootSelection
  taskRecovery?: TaskRecoveryDeploymentSelection
  taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20 — hosted only: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
  /** RFC-370 §9.2 V1 — deployment workers started with execution authority. */
  readonly hostedBackgroundOwners?: readonly SignalledDaemonRuntimeOwner[]
  readonly runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  readonly systemAgentRunFamily?: typeof composeLocalSystemAgentRunFamily
  readonly mcpDiagnostics?: typeof composeLocalMcpDiagnostics
  readonly developmentPurposes?: DevelopmentPurposeSelection
  readonly developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  maintenanceEffectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  evidenceRead?: EvidenceReadBinding
  evidenceDocumentCommands?: EvidenceDocumentCommands
  attemptContext?: AttemptContextStorePort
  daemonHost?: DaemonHostLifecyclePort
  startupLease?: DaemonStartupLeasePort
  /** RFC-370 v2 H7 — the deployment's execution authority; standalone is always active. */
  executionAuthority?: ExecutionAuthorityPort
  /** RFC-370 v2 §3.6 — the deployment's credential mechanism; standalone sessions by default. */
  credentials?: CredentialAdapterSelection
  /** RFC-370 M0 — a platform-provided master key instead of the local secret.key file. */
  secretBox?: SecretBox
  /**
   * RFC-370 M0 — where git and agent runtimes execute. `remote` (a CrewStation
   * service slot) has neither on its host, so the local git and runtime probes
   * do not apply; the selected execution adapters own those dependencies.
   */
  executionHost?: 'local' | 'remote'
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
  readonly provider: DatabaseProvider
  readonly generationId: string
  readonly app: Pick<ReturnType<typeof createComposedApp>, 'fetch'>
  readonly webSocket: ReturnType<typeof buildWebSocketAdapter>
  readonly lifecycle: DaemonLifecycle
  readonly readyOnResume?: boolean
  readonly shutdownIdentity: () => void | Promise<void>
  readonly closeProvider: () => void | Promise<void>
  /** RFC-370 v2 §3.2 — background handles start when this authority is first active. */
  readonly execution?: {
    readonly authority: Pick<ExecutionAuthorityPort, 'current' | 'whenActive'>
    readonly onActivationFailure: (error: unknown) => void
  }
}

type DatabaseMigrationAdmission = Parameters<typeof composeDatabaseMigrationModule>[0]['admission']

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

/** RFC-370 v2 §3.2 — a selected authority gates the background set; standalone has none. */
function executionActivationOf(
  input: Pick<
    DaemonProviderSessionComposeInput,
    'executionAuthority' | 'onExecutionActivationFailure'
  >,
): Pick<DaemonProviderRuntimeComposition, 'execution'> {
  if (input.executionAuthority === undefined) return {}
  const authority = input.executionAuthority
  const onActivationFailure =
    input.onExecutionActivationFailure ??
    ((error: unknown) => {
      throw error
    })
  return { execution: { authority, onActivationFailure } }
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
    ...input.lifecycle.sessionOptions(input.execution),
    readyOnResume: input.readyOnResume,
    shutdownIdentity: input.shutdownIdentity,
    closeProvider: input.closeProvider,
  })
}

interface ComposedPostgresqlProviderSession {
  readonly application: PostgresqlDaemonApplication
  readonly session: Awaited<ReturnType<typeof _createComposedDaemonProviderRuntimeSession>>
}

/**
 * Compose one complete frozen PostgreSQL daemon session. The selected client
 * is captured by owner factories once; HTTP, WS, workers and maintenance all
 * use the same aggregate and are stopped before the provider pool closes.
 */
async function composePostgresqlProviderSession(
  composeInput: DaemonProviderSessionComposeInput,
): Promise<ComposedPostgresqlProviderSession> {
  const input = Object.freeze({
    ...composeInput,
    provider: requireDatabaseProviderRuntime(composeInput.provider, 'postgresql'),
    // RFC-359 AC-10：品牌收窄搬到了 `platform/persistence/`，与紧挨着的
    // `requireDatabaseProviderRuntime` 同一个名字家族；入口只剩调用。
    config: Object.freeze({
      ...composeInput.config,
      database: requireDatabaseConfig(composeInput.config.database, 'postgresql'),
    }),
  })
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

  const application = await composePostgresqlDaemonApplication({
    taskDeletionEffects: input.taskDeletionEffects,
    repositoryPublicationTransport: input.repositoryPublicationTransport,
    nodeRunPromptContentEffects: input.nodeRunPromptContentEffects,
    portArtifactContentEffects: input.portArtifactContentEffects,
    runtimeInventoryContent: input.runtimeInventoryContent,
    taskRunSelection: input.taskRunSelection,
    taskRecovery: input.taskRecovery,
    taskInputFiles: input.taskInputFiles,
    repositoryPreparationEffects: input.repositoryPreparationEffects,
    scratchWorkspaceEffects: input.scratchWorkspaceEffects,
    fusionWorkspaceEffects: input.fusionWorkspaceEffects,
    workspaceMaintenanceFilesystem: input.workspaceMaintenanceFilesystem,
    workspacePresence: input.workspacePresence,
    initializeExecution: input.initializeExecution,
    recoveredExecutionTaskIds: input.recoveredExecutionTaskIds,
    systemAgentRunFamily: input.systemAgentRunFamily,
    mcpDiagnostics: input.mcpDiagnostics,
    developmentPurposes: input.developmentPurposes,
    runtimeManagement: input.runtimeManagement,
    reviewArtifacts: input.reviewArtifacts,
    reviewRollbackSnapshots: input.reviewRollbackSnapshots,
    developmentWorkspaceRepositoryPreparation: input.developmentWorkspaceRepositoryPreparation,
    workspaceExcludeProfiles: input.workspaceExcludeProfiles,
    automationWorkspaceEffects: input.automationWorkspaceEffects,
    actionWorkspaceEffects: input.actionWorkspaceEffects,
    conflictMergeWorkspaceEffects: input.conflictMergeWorkspaceEffects,
    provider: input.provider,
    db,
    config: input.config,
    configuration: input.configuration,
    applicationConfiguration: input.applicationConfiguration,
    taskLaunchConfiguration: input.taskLaunchConfiguration,
    taskArchive: input.taskArchive,
    skillContent: input.skillContent,
    employeePrograms: input.employeePrograms,
    programFixtureProcess: input.programFixtureProcess,
    actionWorkspaceEntries: input.actionWorkspaceEntries,
    repositoryRevisionContent: input.repositoryRevisionContent,
    codeReviewArtifacts: input.codeReviewArtifacts,
    employeeInputArtifacts: input.employeeInputArtifacts,
    missionInputBlobs: input.missionInputBlobs,
    pluginInstaller: input.pluginInstaller,
    beforeEventObservationWrite: input.beforeEventObservationWrite,
    databaseBackup: input.databaseBackup,
    archivedNodeEvents: input.archivedNodeEvents,
    crewStationEvents: input.crewStationEvents,
    intentArtifacts: input.intentArtifacts,
    evidenceArtifacts: input.evidenceArtifacts,
    resourcePackageSkillArtifacts: input.resourcePackageSkillArtifacts,
    resourcePackagePluginArtifacts: input.resourcePackagePluginArtifacts,
    resourcePackageSkillContent: input.resourcePackageSkillContent,
    workspaceContent: input.workspaceContent,
    repositoryRemote: input.repositoryRemote,
    workspaceUploads: input.workspaceUploads,
    isolationWorkspaces: input.isolationWorkspaces,
    repositoryGitWorkspaces: input.repositoryGitWorkspaces,
    repositoryCandidateEffects: input.repositoryCandidateEffects,
    workspaceReads: input.workspaceReads,
    employeeCaseWorkspaceEffects: input.employeeCaseWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    verificationCommands: input.verificationCommands,
    bootExecutionRecovery: input.bootExecutionRecovery,
    customObserverPrograms: input.customObserverPrograms,
    evidenceRead: input.evidenceRead,
    evidenceDocumentCommands: input.evidenceDocumentCommands,
    attemptContext: input.attemptContext,
    daemonRuntime: input.daemonRuntime,
    daemonStartupLease: input.lock,
    token: input.token,
    appHome: Paths.root,
    digitalEmployeeTypePackageDriftPolicy: input.digitalEmployeeTypePackageDriftPolicy,
    configPath: Paths.config,
    daemonInfoPath: Paths.daemonInfo,
    lockPath: Paths.lock,
    secretBox: input.secretBox,
    ...(input.executionAuthority === undefined
      ? {}
      : { executionAuthority: input.executionAuthority }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    sourceWriteWindow: input.sourceWriteWindow,
    databaseMigration,
    dbVersion: input.dbVersion,
    maintenanceStatus: () => maintenanceService.status(),
  })
  const runtime = application.runtime
  const intentModules = runtime.intentModules
  const intentQueuedResumption = intentModules.queuedResumption

  const maintenanceConfiguration = await input.configuration.read()
  const maintenanceService: ReturnType<typeof createMaintenanceService> = createMaintenanceService({
    provider: 'postgresql',
    // 外部服务器的存储在服务端，没有「本地文件快照」这回事——恒为 false 与原行为逐字一致
    // （原来写的是 `options.provider !== 'postgresql' && isDbSnapshotInProgress()`，PG 侧从不跳过）。
    fileSnapshotInFlight: () => false,
    // RFC-359 AC-10：准入存储与 Worker 监工都由**装配方**交出，服务体内不再问 provider。
    // 这一侧的 store 组在已验证代上，没有本地连接可关，所以不给 `close`。
    openAdmissionStore: () => ({ store: createMaintenanceRunStore(db) }),
    startSupervisor: (_config, handlers) =>
      startMaintenanceWorkerSupervisor({
        appHome: Paths.root,
        databaseInit: {
          provider: 'postgresql',
          generationId: input.provider.generation.payload.generationId,
          database: input.config.database,
        },
        effectsBootstrap: input.maintenanceEffectsBootstrap,
        ...handlers,
      }),
    appHome: Paths.root,
    configPath: input.applicationConfiguration.notificationKey,
    loadConfig: () => maintenanceConfiguration,
    payloadSources: Object.freeze({
      activeTaskIds: runtime.taskExecutionModules.activeTaskIds,
      activeIntentApplyJournalIds: intentModules.maintenance.activeApplyJournalIds,
      activeResourceBundleApplyIds: runtime.resourcePackageActivity.activeApplyIds,
      bootIntentTurnIds: intentModules.maintenance.bootTurnIds,
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
      intentQueuedResumption.enqueue(sessionIds)
    },
  })

  const maintenanceBindings = createLazyPausableDaemonRuntimeServiceBindings({
    start: () => maintenanceService.start(),
    runtimeId: 'maintenance',
    closeParticipantId: 'maintenance-final-close',
    service: maintenanceService,
  })
  // RFC-370 — the service's first start recovers boot sessions, which writes.
  // Binding it lazily keeps that out of composition: a hosted standby instance
  // starts it when its activation-gated runtime handle starts, as it does for
  // every other background owner (an eager pause runs the recovery at boot and
  // fails there without the execution lease). The start runs the same
  // start → pause → resume sequence the eager binding ran, only later.
  const mcpRuntimeBindings = createLazyPausableDaemonRuntimeServiceBindings({
    runtimeId: 'mcp-runtime-tests',
    closeParticipantId: 'mcp-runtime-tests-final-close',
    start: async () => {
      await runtime.mcpRuntimeTests.pause()
      await runtime.mcpRuntimeTests.resume()
    },
    service: {
      pause: () => runtime.mcpRuntimeTests.pause(),
      resume: () => runtime.mcpRuntimeTests.resume(),
      stop: () => runtime.mcpRuntimeTests.stop(),
    },
  })
  const taskExecutionBindings = await _bindTaskExecutionProviderBackground(
    runtime.taskExecution.background,
    {
      configuration: input.configuration,
      scheduled: {
        operations: runtime.scheduledTasks.operations,
        identityAccess: runtime.scheduledTaskIdentityAccess,
      },
    },
  )

  const humanGateRecovery = createPostgresqlHumanGateContinuationRecoveryQueries(db)
  const humanGateWorker = createHumanGateContinuationWorkerDefinition({
    artifacts: input.humanGateArtifactRecovery,
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
    createCollaborationWsProjector(createCollaborationCommittedEventProjection(db)),
  ]
  const committedEventProjectionLedger = createCommittedEventProjectionLedger()
  const committedEventPersistence = createCommittedEventDeliveryPersistence(db)
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
          if (runtime.taskExecutionModules.isTaskActive(taskId)) return
          await runtime.workspaceMaintenance.finalizeClaimedWorkspace(taskId)
        },
        async enqueueTaskRunDistill(taskId) {
          await runtime.memory.distillCommands.enqueue({
            sourceKind: 'task-run',
            sourceEventId: taskId,
            taskId,
          })
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
    async maxAttempts() {
      const current = await input.configuration.read()
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
        async drain() {
          if (!stopped) throw new Error('after-commit-event-pump-drain-before-stop')
          await committedEventPump.awaitDrained()
        },
      })
    },
  })

  // RFC-366: the ONE ambient provider the distill path needs. The admission gate
  // runs inside `enqueueDistillJob`, which is reached from clarify / review /
  // feedback / the two execution-end triggers, none of which have a config path
  // to thread. Re-reading here means a settings edit gates the very next event
  // instead of the next daemon restart (D10). A broken config file falls back to
  // the defaults (manual-only, every source on) rather than silently admitting
  // everything.
  //
  // RFC-366 T6/T8 (2026-09-22): this also carries RFC-050's `memoryDistillLang`
  // as `DistillPolicy.outputLang`. It used to be a second provider with its own
  // setter and its own `loadConfig` call, registered right here in BOTH engine
  // compositions — four registration sites for two knobs that are read at the
  // same instant, from the same file, by the same function. One provider now.
  const memoryDistillRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'memory-distill',
    intervalMs: 1_000,
    beforeStart: () => runtime.memory.distillWorker.recoverRunning().then(() => undefined),
    async run() {
      const current = await input.configuration.read()
      if (current.memoryDistillerEnabled === false) return
      await runtime.memory.distillWorker.tick({
        runtimeName: current.memoryDistillRuntime ?? null,
        defaultRuntime: current.defaultRuntime ?? null,
        model: current.memoryDistillModel ?? null,
        sourceContextBudget: resolveSourceContextBudget(current.memoryDistillSourceContext),
        timeoutMs: current.memoryDistillTimeoutMs,
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
    run: () => runtime.developmentAutomationModules.sweepWakesWhileDraining(),
    onError(error) {
      input.log.warn('development wake sweep failed', {
        err: error instanceof Error ? error.message : String(error),
      })
    },
  })
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
      await runtime.crewStationEvents?.runPending({
        observe: (observation) => runtime.eventCenter.commands.observe(observation),
        wakeTerminalControl: (effectId) => runtime.webhookTerminalControl.wake(effectId),
      })
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
    run: () => reconcileRunningFusions({ operations: runtime.fusion }),
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
    async run() {
      await runTaskIdleTimeoutSweep(
        runtime.taskIdleTimeout,
        (await input.configuration.read()).taskIdleTimeout,
      )
    },
    onError(error) {
      input.log.error('PostgreSQL task idle-timeout sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  const backupRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'scheduled-backup',
    async start() {
      const current = await input.configuration.read()
      const ticker = startBackupScheduler({
        createScheduledBackup: () =>
          input.databaseBackup
            ? // RFC-370 v3 C10: hosted backups never capture workspaces.
              input.databaseBackup.request({ includeWorktrees: false, kind: 'scheduled' })
            : application.core.systemOperations.application.commands.requestBackup.execute(
                application.core.systemOperations.localContext,
                { includeWorktrees: true },
              ),
        intervalMs: current.backupIntervalMs,
        retentionCount: current.backupRetentionCount,
        retentionDays: current.backupRetentionDays,
        maxTotalBytes: current.backupMaxTotalBytes,
        protectedKeepCount: current.backupProtectedKeepCount,
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
        async drain() {
          if (!stopped) throw new Error('scheduled-backup-drain-before-stop')
          await ticker.awaitIdle()
        },
      })
    },
  })
  const submoduleRefreshRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'submodule-refresh',
    async start() {
      // RFC-370 §10 V17: a hosted deployment keeps no mirror to refresh — each
      // task fetches the latest inside its own volume. The handle stays
      // registered (both daemons freeze the same writers) but runs nothing.
      if (input.repositoryRemote !== undefined)
        return Object.freeze({ stop: () => undefined, drain: async () => undefined })
      const ticker = await startConfiguredSubmoduleRefreshLoop(
        application.core.repositoryWorkspaceStore,
        input.configuration,
        undefined,
        Paths.root,
        input.secretBox,
      )
      const unregister = registerConfigAppliedListener(
        input.applicationConfiguration.notificationKey,
        () => ticker.reconfigure().then(() => undefined),
      )
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          unregister()
          ticker.stop()
        },
        async drain() {
          if (!stopped) throw new Error('submodule-refresh-drain-before-stop')
          await ticker.awaitIdle()
        },
      })
    },
  })
  const batchImportRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'batch-import-gc',
    async start() {
      const ticker = startBatchImportGc(
        undefined,
        (await input.configuration.read()).repoBatchImportRetentionMs,
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

  // RFC-359 W3-T14：与 SQLite 会话同一组关闭参与者、同一顺序（SQLite 此前在监听器 shutdown 里显式做）。
  const memoryDistillRecoverOnClose: DaemonProviderCloseParticipant = Object.freeze({
    id: 'memory-distill-recover-running',
    close: async () => {
      await runtime.memory.distillWorker.recoverRunning()
    },
  })
  const gracefulTaskShutdown: DaemonProviderCloseParticipant = Object.freeze({
    id: 'task-execution-graceful-shutdown',
    async close({ reason }: Parameters<DaemonProviderCloseParticipant['close']>[0]) {
      if (reason !== 'daemon-shutdown') return
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(
        {
          controller: createTaskExecutionShutdownController(runtime.taskExecution.executionModule),
          operations: runtime.taskExecution.shutdown,
          recovery: runtime.taskExecution.recovery,
        },
        0,
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

  const lifecycleProgram = composeDaemonLifecycle({
    provider: 'postgresql',
    profile: input.executionAuthority?.mode,
    log: input.log,
    steps: {
      ...application.lifecycleSteps,
      'runtime-declarations': async () => {
        const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))
        if (notModeled.length > 0) {
          input.log.info('runtime declaration self-check: not-modeled dispositions', { notModeled })
        }
      },
      'runtime-registry': async () => {
        await initializeRuntimeRegistryBoot({
          operations: application.core.runtimeRegistry,
          config: input.config,
          legacyConfiguration: input.runtimeLegacyConfiguration,
          onRecoverableFailure(error) {
            input.log.warn('builtin runtime seed/migration on boot failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          },
        })
      },
      'process-registrations': async () => {
        const register = application.lifecycleSteps['process-registrations']
        if (register !== NotApplicable) await register()
        setMemoryDistillPolicyProvider(async () => {
          try {
            return resolveDistillPolicy(await input.configuration.read())
          } catch {
            return DEFAULT_DISTILL_POLICY
          }
        })
      },
      'maintenance-boot-snapshot': async () => {
        await maintenanceService.captureBootSnapshot()
      },
    },
    runtimeJobs: {
      'intent-queued-resumption': intentQueuedResumption.runtimeFactory,
      'task-execution': taskExecutionBindings.runtimeFactory,
      maintenance: maintenanceBindings.runtimeFactory,
      'mcp-runtime-tests': mcpRuntimeBindings.runtimeFactory,
    },
    backgroundJobs: {
      'webhook-terminal-control': webhookTerminalRuntimeFactory,
      'after-commit-event-pump': afterCommitPumpFactory,
      'human-gate-continuation': humanGateRuntimeFactory,
      'committed-event-dispatcher': committedEventRuntimeFactory,
      'memory-distill': memoryDistillRuntimeFactory,
      'development-wake': developmentWakeRuntimeFactory,
      'digital-employee-os': digitalEmployeeRuntimeFactory,
      'event-center': eventCenterRuntimeFactory,
      'fusion-reconcile': fusionRuntimeFactory,
      'resource-limits': limitsRuntimeFactory,
      'task-idle-timeout': idleTimeoutRuntimeFactory,
      'scheduled-backup': backupRuntimeFactory,
      'submodule-refresh': submoduleRefreshRuntimeFactory,
      'batch-import-gc': batchImportRuntimeFactory,
    },
    closeParticipants: {
      'memory-distill-recover-running': memoryDistillRecoverOnClose,
      'task-execution-final-close': taskExecutionBindings.closeParticipant,
      'maintenance-final-close': maintenanceBindings.closeParticipant,
      'mcp-runtime-tests-final-close': mcpRuntimeBindings.closeParticipant,
      'task-execution-graceful-shutdown': gracefulTaskShutdown,
      'webhook-terminal-control': webhookTerminalClose,
    },
    profileJobs: (input.hostedBackgroundOwners ?? []).map((owner) =>
      createSignalledDaemonRuntimeHandleFactory(owner, DAEMON_SHUTDOWN_ABORT_REASON),
    ),
  })
  await lifecycleProgram.initialize(input.initializeExecution)
  const session = await _createComposedDaemonProviderRuntimeSession({
    provider: 'postgresql',
    generationId: input.provider.generation.payload.generationId,
    ...executionActivationOf(input),
    app: application.app,
    webSocket: application.webSocket,
    lifecycle: lifecycleProgram,
    readyOnResume: input.lifecycle.operationId !== 'daemon-start',
    shutdownIdentity: () => application.core.identityAccess.shutdown(),
    closeProvider: () => input.provider.close(),
  })
  return Object.freeze({ application, session })
}

/** RFC-359 W3-T16：两个 provider 的会话装配器共用的输入——`startCommand` 只准备这一份。 */
interface DaemonProviderSessionComposeInput {
  readonly provider: ResolvedDatabaseProviderRuntime
  readonly lifecycle: DaemonProviderSessionLifecycleInput
  readonly config: ReturnType<typeof loadConfig>
  readonly configuration: ApplicationConfigurationQueries
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly runtimeLegacyConfiguration: RuntimeLegacyConfigurationPort
  readonly taskArchive?: TaskArchiveContentBinding
  readonly skillContent?: SkillContentBinding
  readonly employeePrograms?: ProgramArtifactPort
  readonly programFixtureProcess?: ScriptFixtureProcess
  readonly actionWorkspaceEntries?: ActionWorkspaceEntries
  readonly repositoryRevisionContent?: RepositoryRevisionContentFactory
  readonly codeReviewArtifacts?: CodeReviewArtifactStore
  readonly employeeInputArtifacts?: EmployeeInputArtifactPort
  readonly missionInputBlobs?: MissionInputBlobPersistence
  readonly pluginInstaller?: PluginInstallerPort
  readonly beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  readonly humanGateArtifactRecovery?: HumanGateArtifactRecovery
  readonly databaseBackup?: DatabaseBackupEffects
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly intentArtifacts?: IntentArtifactSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  readonly resourcePackageSkillContent?: SkillPackageContentReader
  readonly workspaceContent?: WorkspaceContentEffectsFactory
  readonly repositoryRemote?: RepositoryRemoteEffects
  readonly workspaceUploads: WorkspaceUploadContentFactory
  readonly isolationWorkspaces: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces: RepositoryGitWorkspaceFactory
  readonly repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  readonly workspaceReads: RepositoryWorkspaceReadQueries
  readonly employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
  readonly verificationCommands?: VerificationCommandEffectsFactory
  readonly customObserverPrograms?: CustomObserverProgramFactory
  readonly bootExecutionRecovery?: BootExecutionRecoveryFactory
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  readonly taskDeletionEffects?: TaskDeletionEffects
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  readonly nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  readonly taskRunSelection?: TaskRunRootSelection
  readonly taskRecovery?: TaskRecoveryDeploymentSelection
  readonly taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20 — hosted only: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
  readonly hostedBackgroundOwners?: readonly SignalledDaemonRuntimeOwner[]
  readonly runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  readonly systemAgentRunFamily?: typeof composeLocalSystemAgentRunFamily
  readonly mcpDiagnostics?: typeof composeLocalMcpDiagnostics
  readonly developmentPurposes?: DevelopmentPurposeSelection
  readonly developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  readonly workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  readonly maintenanceEffectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  readonly evidenceRead?: EvidenceReadBinding
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
  readonly attemptContext?: AttemptContextStorePort
  readonly daemonRuntime: DaemonRuntimeQueries
  readonly token: string
  readonly secretBox: SecretBox
  readonly executionAuthority?: ExecutionAuthorityPort
  readonly credentials?: CredentialAdapterSelection
  /** Reported when a background handle fails to start on activation. */
  readonly onExecutionActivationFailure?: (error: unknown) => void
  readonly dbVersion: number
  readonly migrationAdmission: DatabaseMigrationAdmission
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly log: ReturnType<typeof createLogger>
  readonly lock: DaemonStartupLease
  readonly migrationsFolder: string
  readonly digitalEmployeeTypePackageDriftPolicy: 'draft-overlay' | 'reject'
}

interface ComposedDaemonProviderSession {
  readonly application: {
    readonly core: {
      readonly authRuntime: Pick<
        PostgresqlDaemonApplication['core']['authRuntime'],
        'isBootstrapRequired'
      >
    }
  }
  readonly session: Awaited<ReturnType<typeof _createComposedDaemonProviderRuntimeSession>>
}

/** RFC-370 §9.2 V9 — selections only the hosted deployment supplies. A hosted
 * deployment always runs on PostgreSQL, so the SQLite root never threads them:
 * it composes the standalone owners directly. */
export const HOSTED_ONLY_SELECTIONS = [
  'credentials',
  'systemAgentRunFamily',
  'workspacePresence',
  'reviewArtifacts',
  'reviewRollbackSnapshots',
  'taskInputFiles',
  'mcpDiagnostics',
  'beforeEventObservationWrite',
  'humanGateArtifactRecovery',
  'runtimeInventoryContent',
  'runtimeManagement',
  'developmentWorkspaceRepositoryPreparation',
  'archivedNodeEvents',
  'crewStationEvents',
  'intentArtifacts',
  'databaseBackup',
  'hostedBackgroundOwners',
  'taskRecovery',
  'repositoryPublicationTransport',
  'programFixtureProcess',
  'actionWorkspaceEntries',
  'repositoryRemote',
  'repositoryRevisionContent',
  'codeReviewArtifacts',
  'fusionWorkspaceEffects',
] as const satisfies readonly (keyof DaemonProviderSessionComposeInput)[]
type HostedOnlySelection = (typeof HOSTED_ONLY_SELECTIONS)[number]
type SqliteProviderSessionComposeInput = Omit<
  DaemonProviderSessionComposeInput,
  HostedOnlySelection
>

export function standaloneSelectionsOf(
  input: DaemonProviderSessionComposeInput,
): SqliteProviderSessionComposeInput {
  const hosted = HOSTED_ONLY_SELECTIONS.filter((key) => input[key] !== undefined)
  if (hosted.length > 0)
    throw new Error(`hosted-deployment-requires-postgresql: ${hosted.join(', ')}`)
  return input
}

type DaemonProviderSessionComposer = (
  input: DaemonProviderSessionComposeInput,
) => Promise<ComposedDaemonProviderSession>

/** 按 provider 查表；表按 `DatabaseProvider` 穷举，少一个 provider 就编译不过。 */
function composeDaemonProviderSession(
  input: DaemonProviderSessionComposeInput,
): Promise<ComposedDaemonProviderSession> {
  const composers = {
    sqlite: composeSqliteProviderSession,
    postgresql: composePostgresqlProviderSession,
  } satisfies Record<DatabaseProvider, DaemonProviderSessionComposer>
  return composers[input.provider.provider](input)
}

/**
 * RFC-359 W3-T14 —— 监听器与关机序列只有一份，两个 provider 共用。
 *
 * 此前 PostgreSQL 走这里的前身 `servePostgresqlDaemon`，SQLite 在 `startCommand` 尾部另有一段
 * 手写的 `Bun.serve` + `shutdown()`——后者在 `bootstrap.stop()` 之前显式做蒸馏 worker 回收、
 * after-commit 泵注销、webhook 终态控制停机与任务优雅关停，而 PG 把同样几步放在会话的关闭
 * 参与者里。合一后只剩会话那一种放法：`shutdown()` 只做「摘 daemon info → 停监听 →
 * `bootstrap.stop()` → 收控制口与锁 → exit」，provider 专属的收尾全部在各自会话的
 * `providerCloseParticipants` 里、两侧同一组 id。
 */
export async function serveDaemon(input: {
  readonly bootstrap: Pick<
    DaemonProviderBootstrap,
    'runBusinessRequest' | 'tryUpgrade' | 'fetch' | 'websocketHandlers' | 'stop'
  >
  readonly authRuntime: Pick<
    PostgresqlDaemonApplication['core']['authRuntime'],
    'isBootstrapRequired'
  >
  readonly postReady?: () => Promise<void>
  readonly databaseProvider: DatabaseProvider
  readonly token: string
  readonly bindHost: string
  readonly bindPort: number
  readonly lock: DaemonStartupLease
  readonly daemonHost: DaemonHostLifecyclePort
  readonly log: ReturnType<typeof createLogger>
  readonly exitRequests?: (requestExit: (reason: string) => void) => void
}): Promise<never> {
  const server = Bun.serve({
    // Bun --hot otherwise aliases the HTTP and control listeners when both
    // request an ephemeral port. Keep this application's reload identity distinct.
    id: `agent-workflow-http:${input.bindHost}:${input.bindPort}`,
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
  input.log.info('listening', { url: baseUrl, databaseProvider: input.databaseProvider })

  const application = composeDaemonHostApplication({
    host: input.daemonHost,
    postReady: input.postReady,
    databaseProvider: input.databaseProvider,
    log: input.log,
    describeFailure: describeDaemonProviderSessionFailure,
    readyInfo: () => ({
      // This constructor always binds TCP; the Bun Server type also covers Unix sockets.
      host: server.hostname!,
      port: server.port!,
      url: baseUrl,
      startedAt: new Date().toISOString(),
    }),
    readBootstrapRequired: () => input.authRuntime.isBootstrapRequired(),
    readyBrowserUrl: (bootstrapRequired) =>
      readyBrowserUrl(baseUrl, input.token, bootstrapRequired),
    async stopListener() {
      await server.stop(true)
    },
    async stopApplication() {
      await input.bootstrap.stop()
    },
    releaseAuthority: () => input.lock.release(),
    releaseAuthorityOnExit: () => input.lock.releaseOnExit(),
    ...(input.exitRequests === undefined ? {} : { exitRequests: input.exitRequests }),
  })
  return await application.run()
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
  const digitalEmployeeTypePackageDriftPolicy: 'draft-overlay' | 'reject' =
    !IS_EMBEDDED &&
    devLockHandoffMs() > 0 &&
    process.env.AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY === '1'
      ? 'draft-overlay'
      : 'reject'

  // 2. The selected startup provider supplies exclusivity and release ACKs.
  const lock = await composeDaemonStartupLease({
    selected: opts.startupLease,
    local: () => ({
      lockPath: Paths.lock,
      controlPath: Paths.controlFile,
      maxWaitMs: devLockHandoffMs(),
      log,
    }),
  })
  await runDaemonStartupWithLease(lock, async () => {
    log.info('lock acquired', lock.diagnostics)
    const daemonHost = selectDaemonHostLifecycle(opts.daemonHost, {
      infoPath: Paths.daemonInfo,
      controlPath: Paths.controlFile,
      pid: process.pid,
      devWatch: devLockHandoffMs() > 0,
    })

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
    const preOpenRecovery = await prepareDatabasePreOpenRecovery({
      contract: logicalSchemaContract,
      migrationsFolder,
      recovery: opts.databasePreOpenRecovery,
    })
    const schemaHistory = preOpenRecovery.history
    // A failure inside applyPendingRestoreIfAny self-heals (impl-gate P1-1): the
    // staged dir is quarantined and the boot continues on the untouched DB. The
    // catch below only guards truly unexpected filesystem-level throws.
    {
      try {
        const applied = await preOpenRecovery.applyStagedRestore()
        if (applied) log.warn('staged restore applied on boot', { db: Paths.db })
      } catch (err) {
        await lock.release()
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
    const applicationConfiguration =
      opts.applicationConfiguration ??
      composeApplicationConfigurationBinding({
        kind: 'file',
        configPath: Paths.config,
        ...(opts.configuration === undefined ? {} : { queries: opts.configuration }),
      })
    const configuration = applicationConfiguration.queries
    const taskLaunchConfiguration = composeTaskLaunchConfiguration(
      opts.applicationConfiguration !== undefined ||
        applicationConfiguration.synchronousQueries === undefined
        ? { kind: 'selected', queries: configuration }
        : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
    )
    const runtimeLegacyConfiguration =
      opts.runtimeLegacyConfiguration ?? composeFileRuntimeLegacyConfiguration(Paths.config)
    let config = await configuration.read()
    if (config.logLevel !== 'info') {
      configureLogger({ level: config.logLevel })
    }
    log.info('config loaded', {
      path: Paths.config,
      language: config.language,
      theme: config.theme,
    })

    // RFC-370 M0: a CrewStation service slot has no git and no agent runtime on
    // its host — execution and workspaces run in platform task containers — so
    // the local host probes below apply only where this process executes work.
    if ((opts.executionHost ?? 'local') === 'local') {
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
        await lock.release()
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
    } else {
      log.info('execution runs on the platform; local git and runtime probes skipped')
    }

    // Provider-independent bootstrap secrets are needed by either selected
    // composition. They are created before opening a client, but no owner module
    // receives them until its verified provider graph is composed below.
    const secretBox = opts.secretBox ?? createSecretBox(Paths.secretKeyFile)
    log.info('secret box ready', {
      keyFile: opts.secretBox === undefined ? Paths.secretKeyFile : 'deployment-provided',
    })
    const token = ensureTokenFile(Paths.tokenFile)
    log.info('token ready', { tokenFile: Paths.tokenFile })
    // RFC-370 v2 §3.2 — crash-only execution authority: leaving active, or a
    // background set that fails to activate, drains and exits non-zero so the
    // platform restarts this instance as standby. Standalone never loses it.
    const executionExit = createExecutionExitRequests()
    opts.executionAuthority?.onLost((state) => {
      log.warn('execution authority lost', { state: state.kind })
      executionExit.request(`execution-authority-${state.kind}`)
    })
    const dbVersion = existsSync(migrationsFolder)
      ? readdirSync(migrationsFolder).filter((file) => file.endsWith('.sql')).length
      : 0
    // 5. DB — resolve the verified live generation before opening any provider
    // client. The pointer is authoritative; config may supply mechanism settings
    // but cannot silently select a different database.
    const preparedDatabase = await prepareDaemonDatabaseProviderForBoot({
      configuration: applicationConfiguration.databaseConfiguration,
      installation: opts.databaseInstallation,
      file: {
        config: config.database,
        sqlitePath: Paths.db,
        generationPointerPath: Paths.databaseGenerationPointer,
        operationsRoot: Paths.databaseMigrationsDir,
        contract: logicalSchemaContract,
        history: schemaHistory,
        lockPath: Paths.lock,
        lock,
        sqliteOptions: {
          migrationsFolder,
          synchronous: config.sqliteSynchronous,
          pageCacheMib: config.sqlitePageCacheMib,
          mmapMib: config.sqliteMmapMib,
          slowQueryMs: config.sqliteSlowQueryMs,
          skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',
          developmentIntegrity: opts.developmentIntegrity,
        },
        beforeSqliteOpen: () =>
          maybePreMigrationBackup({
            appHome: Paths.root,
            dbPath: Paths.db,
            migrationsFolder,
            enabled: config.backupOnMigration,
          }).then(() => undefined),
      },
    }).catch(async (err: unknown) => {
      if (isDbCorruptionFailure(err)) {
        // RFC-213 fail-closed: never serve a corrupt DB. Print the available
        // backups + the exact restore command, then exit non-zero. The DB is
        // unwritable, so this does NOT record a recovery_event.
        await lock.release()
        process.stderr.write(formatDbCorruptionGuidance(err))
        process.exit(1)
      }
      if (err instanceof DbSchemaDriftError) {
        await lock.release()
        process.stderr.write(formatDbSchemaDriftGuidance(err))
        process.exit(1)
      }
      throw err
    })
    config = { ...config, database: preparedDatabase.databaseConfig }
    const databaseProvider = preparedDatabase.runtime

    // DB — open + apply migrations. dbVersion = number of SQL files in the
    // bundled migrations folder (== the highest version we've applied, since
    // openDb() applies all pending migrations on startup). The migrations folder
    // itself (and any staged restore) was already resolved/applied at step 2.5.

    // RFC-213/RFC-223: raw pre-migration safety backup BEFORE openDb applies
    // migrations. A pending migration without its rollback generation is fatal;
    // backupOnMigration=false is the operator's explicit opt-out.
    // RFC-359 W3-T16：这里没有 provider 执行分支——按 provider 查表取会话装配器，
    // bootstrap / resume / 监听全部走同一条中立序列（design §6 / §7 守卫 4）。
    const bindHost = opts.host ?? config.bindHost
    const bindPort = opts.port ?? config.bindPort ?? 0
    const lifecycle = Object.freeze({
      operationId: 'daemon-start',
      provider: databaseProvider.provider,
      generationId: databaseProvider.generation.payload.generationId,
    })
    const sessionInput = Object.freeze({
      taskDeletionEffects: opts.taskDeletionEffects,
      repositoryPublicationTransport: opts.repositoryPublicationTransport,
      nodeRunPromptContentEffects: opts.nodeRunPromptContentEffects,
      portArtifactContentEffects: opts.portArtifactContentEffects,
      runtimeInventoryContent: opts.runtimeInventoryContent,
      taskRunSelection: opts.taskRunSelection,
      taskRecovery: opts.taskRecovery,
      taskInputFiles: opts.taskInputFiles,
      repositoryPreparationEffects: opts.repositoryPreparationEffects,
      scratchWorkspaceEffects: opts.scratchWorkspaceEffects,
      fusionWorkspaceEffects: opts.fusionWorkspaceEffects,
      workspaceMaintenanceFilesystem: opts.workspaceMaintenanceFilesystem,
      workspacePresence: opts.workspacePresence,
      initializeExecution: opts.initializeExecution,
      recoveredExecutionTaskIds: opts.recoveredExecutionTaskIds,
      hostedBackgroundOwners: opts.hostedBackgroundOwners,
      systemAgentRunFamily: opts.systemAgentRunFamily,
      mcpDiagnostics: opts.mcpDiagnostics,
      developmentPurposes: opts.developmentPurposes,
      runtimeManagement: opts.runtimeManagement,
      reviewArtifacts: opts.reviewArtifacts,
      reviewRollbackSnapshots: opts.reviewRollbackSnapshots,
      developmentWorkspaceRepositoryPreparation: opts.developmentWorkspaceRepositoryPreparation,
      workspaceExcludeProfiles: opts.workspaceExcludeProfiles,
      automationWorkspaceEffects: opts.automationWorkspaceEffects,
      actionWorkspaceEffects: opts.actionWorkspaceEffects,
      conflictMergeWorkspaceEffects: opts.conflictMergeWorkspaceEffects,
      config,
      configuration,
      applicationConfiguration,
      taskLaunchConfiguration,
      runtimeLegacyConfiguration,
      taskArchive: opts.taskArchive,
      skillContent: opts.skillContent,
      employeePrograms: opts.employeePrograms,
      programFixtureProcess: opts.programFixtureProcess,
      actionWorkspaceEntries: opts.actionWorkspaceEntries,
      repositoryRevisionContent: opts.repositoryRevisionContent,
      codeReviewArtifacts: opts.codeReviewArtifacts,
      employeeInputArtifacts: opts.employeeInputArtifacts,
      missionInputBlobs: opts.missionInputBlobs,
      pluginInstaller: opts.pluginInstaller,
      beforeEventObservationWrite: opts.beforeEventObservationWrite,
      humanGateArtifactRecovery: opts.humanGateArtifactRecovery,
      databaseBackup: opts.databaseBackup,
      archivedNodeEvents: opts.archivedNodeEvents,
      crewStationEvents: opts.crewStationEvents,
      intentArtifacts: opts.intentArtifacts,
      evidenceArtifacts: opts.evidenceArtifacts,
      resourcePackageSkillArtifacts: opts.resourcePackageSkillArtifacts,
      resourcePackagePluginArtifacts: opts.resourcePackagePluginArtifacts,
      resourcePackageSkillContent: opts.resourcePackageSkillContent,
      workspaceContent: opts.workspaceContent,
      repositoryRemote: opts.repositoryRemote,
      workspaceUploads: selectWorkspaceUploadContentFactory(opts.workspaceUploads),
      isolationWorkspaces: selectIsolationWorkspaceFactory(opts.isolationWorkspaces),
      repositoryGitWorkspaces: selectRepositoryGitWorkspaceFactory(opts.repositoryGitWorkspaces),
      repositoryCandidateEffects: opts.repositoryCandidateEffects,
      workspaceReads: selectRepositoryWorkspaceReadQueries(opts.workspaceReads),
      employeeCaseWorkspaceEffects: opts.employeeCaseWorkspaceEffects,
      repositoryBaselines: opts.repositoryBaselines,
      verificationCommands: opts.verificationCommands,
      bootExecutionRecovery: opts.bootExecutionRecovery,
      customObserverPrograms: opts.customObserverPrograms,
      maintenanceEffectsBootstrap: opts.maintenanceEffectsBootstrap,
      evidenceRead: opts.evidenceRead,
      evidenceDocumentCommands: opts.evidenceDocumentCommands,
      attemptContext: opts.attemptContext,
      daemonRuntime: daemonHost,
      token,
      secretBox,
      ...(opts.executionAuthority === undefined
        ? {}
        : { executionAuthority: opts.executionAuthority }),
      ...(opts.credentials === undefined ? {} : { credentials: opts.credentials }),
      onExecutionActivationFailure(error: unknown) {
        log.error('background activation failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        executionExit.request('execution-activation-failed')
      },
      dbVersion,
      log,
      lock,
      migrationsFolder,
      digitalEmployeeTypePackageDriftPolicy,
    })
    const { initial, bootstrap: daemonProviderBootstrap } = await composeDaemonProviderBootstrap({
      initial: lifecycle,
      composeInitial: (bindings) =>
        composeDaemonProviderSession({
          ...sessionInput,
          ...bindings,
          provider: databaseProvider,
          lifecycle,
        }),
      sessionFactory: {
        async create(lifecycleInput, bindings) {
          // 只有迁移目标才会被重新装配；源 provider（SQLite）在割接后退役，不能再被当作
          // 新会话的来源——判据取自 provider 特征表，不在这里写 provider 字面量。
          if (databaseProviderTraits(lifecycleInput.provider).migrationRole !== 'target') {
            throw new Error('provider-session-source-retired')
          }
          const nextConfig = await configuration.read()
          const nextProvider = resolveDatabaseProviderRuntime({
            config: nextConfig.database,
            sqlitePath: Paths.db,
            generationPointerPath: Paths.databaseGenerationPointer,
            operationsRoot: Paths.databaseMigrationsDir,
            contract: logicalSchemaContract,
          })
          if (
            nextProvider.provider !== lifecycleInput.provider ||
            nextProvider.generation.payload.generationId !== lifecycleInput.generationId
          ) {
            await nextProvider.close()
            throw new Error('daemon-provider-target-generation-mismatch')
          }
          return (
            await composeDaemonProviderSession({
              ...sessionInput,
              ...bindings,
              config: nextConfig,
              provider: nextProvider,
              lifecycle: lifecycleInput,
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
    await initial.session.resume(lifecycle)
    await serveDaemon({
      bootstrap: daemonProviderBootstrap,
      authRuntime: initial.application.core.authRuntime,
      postReady: () => initial.session.postReady?.() ?? Promise.resolve(),
      databaseProvider: databaseProvider.provider,
      token,
      bindHost,
      bindPort,
      lock,
      daemonHost,
      log,
      exitRequests: executionExit.subscribe,
    })
  })
}

/**
 * RFC-359 W3-T16 —— SQLite 会话装配（此前是 `startCommand` 里 1700 行的内联段）。
 * 与 `composePostgresqlProviderSession` 同一份输入 / 输出契约，由 `composeDaemonProviderSession`
 * 按 provider 查表调用；`startCommand` 本身不再有 provider 执行分支。
 */
async function composeSqliteProviderSession(
  input: DaemonProviderSessionComposeInput,
): Promise<ComposedDaemonProviderSession> {
  // RFC-370 §9.2 V9: a SQLite root refuses hosted-only selections before any
  // composition (hosted deployments are PostgreSQL-only).
  standaloneSelectionsOf(input)
  const developmentWorkspaceEffects = selectDevelopmentWorkspaceEffectBinding({
    actionWorkspaceEffects: input.actionWorkspaceEffects,
    automationWorkspaceEffects: input.automationWorkspaceEffects,
    conflictWorkspaceSelected: input.conflictMergeWorkspaceEffects !== undefined,
  })
  const databaseProvider = requireDatabaseProviderRuntime(input.provider, 'sqlite')
  const developmentPurposeRoot = composeDevelopmentPurposeRoot({
    appHome: Paths.root,
    selection: input.developmentPurposes,
    evidenceArtifacts: input.evidenceArtifacts,
    evidenceDocumentCommands: input.evidenceDocumentCommands,
  })
  const selectedTaskRuns = selectTaskRunRootSelection(input.taskRunSelection)
  const workspaceExcludeProfilesFor = composeTaskWorkspaceExcludeProfilesFor(
    input.workspaceExcludeProfiles,
  )
  const nodeRunPrompts =
    selectedTaskRuns === undefined
      ? composeNodeRunPromptOperations(input.nodeRunPromptContentEffects, Paths.runsDir)
      : selectedTaskRuns.nodeRunPrompts
  const portArtifacts =
    selectedTaskRuns === undefined
      ? composePortArtifactOperations(input.portArtifactContentEffects, Paths.root)
      : selectedTaskRuns.portArtifacts
  const taskRunRoot =
    selectedTaskRuns === undefined
      ? composeLocalTaskRunRootSelection({ nodeRunPrompts, portArtifacts })
      : selectedTaskRuns
  const {
    config,
    configuration,
    applicationConfiguration,
    runtimeLegacyConfiguration,
    token,
    secretBox,
    dbVersion,
    migrationAdmission,
    sourceWriteWindow,
    log,
    lock,
    migrationsFolder,
    digitalEmployeeTypePackageDriftPolicy,
    lifecycle,
  } = input
  const taskLaunchConfiguration = input.taskLaunchConfiguration
  // Boot preparation already applied and verified migrations on this exact client.
  const db = databaseProvider.openClient({ migrationsFolder })

  // RFC-300 composition: integration owns the direct-Webhook attribution
  // predicate; lifecycle owns the atomic terminal status+claim write; GC owns
  // physical deletion. Read config at each transition so the setting is hot.
  log.info('db ready', { path: Paths.db, dbVersion })

  // RFC-282 §4.3 — runtime declaration self-check, before any business
  // service: every registered driver must state a stance on every declaration
  // face (a declared-but-unimplemented face makes the verification layer
  // believe it is verifying — RFC-247 rationale). 'not-modeled' policy rows
  // are reported separately so the gap stays visible.

  // RFC-279: migration 0147 can leave a direct-upgrade legacy URL under a
  // closed escrow prefix. Converge credentials immediately after openDb,
  // before any recovery, seeder, scheduler, or HTTP behavior can observe the
  // database. The provider-independent SecretBox was created before provider
  // selection and is reused by this selected SQLite graph.
  const realtimePolicy = composeDaemonRealtimePolicy({
    resourceVisibility: {
      canViewResource: (actor, type, row) =>
        resourceCatalog.authorization.canViewResource(actor, type, row),
    },
    memoryVisibility: {
      canViewMemory: (authority, actor, scope) =>
        memoryCatalog.queries.canView({ authority, actor }, scope),
    },
    repoImportOwnerUserId: batchOwnerUserId,
    redactTaskEventPayload: redactEventPayload,
  })
  const providerCore = composeDaemonProviderCore({
    daemonToken: token,
    db,
    sourceWriteWindow: sourceWriteWindow,
    appHome: Paths.root,
    adapters: DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({
      db,
      appHome: Paths.root,
      dbPath: Paths.db,
      lockPath: Paths.lock,
      secretBox,
    }),
    secretBox,
    realtimePolicy,
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
  const identityAccess = providerCore.identityAccess
  const runtimeRegistry = providerCore.runtimeRegistry
  const observationModules = composeDaemonObservationModules({
    db,
    appHome: Paths.root,
    configuration,
    notificationKey: applicationConfiguration.notificationKey,
    identityAccess,
    daemonActor: providerCore.daemonActor,
    runtimeRegistry,
    adapters: standaloneModuleAdapters(),
    mcpCatalog: () => mcpCatalog,
  })
  const {
    observationCalls,
    memorySystemAgentBinding,
    workspacePresence,
    runtimeSessionLeases,
    mcpRuntimeTests,
  } = observationModules
  const resourceCatalogModules = composeDaemonResourceCatalogModules({
    db,
    skillContentRoot: Paths.root,
    skillContent: input.skillContent,
    pluginInstaller: input.pluginInstaller,
    runtimeProfiles: { get: (name) => runtimeRegistry.getRuntime(name) },
    mcpRuntime: {
      prepareDelete: (id) => mcpRuntimeTests.prepareMcpDelete(id),
      reconcileDurableIntents: () => mcpRuntimeTests.reconcileDurableIntents(),
    },
  })
  const {
    resourceCatalog,
    agentResourceIntegrity,
    skillCatalogBoot,
    digitalEmployeeAgentTemplates,
    mcpCatalog,
  } = resourceCatalogModules
  const repositoryCredentials = composeDaemonRepositoryCredentials({
    db,
    appHome: Paths.root,
    secretBox,
    developmentPurposeRoot,
    repositoryWorkspaceStore: providerCore.repositoryWorkspaceStore,
    repositoryWorkspaceOperations: providerCore.repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository: providerCore.repositoryTransportCredentialRepository,
  })
  const {
    repositoryWorkspaceStore,
    repositoryTransport: repositoryTransportModule,
    codeHostConnections: repositoryMetadataConnections,
    developmentDeliveryProvider,
    repositoryPublicationTransport,
  } = repositoryCredentials
  const repositoryTransportRepository = providerCore.repositoryTransportCredentialRepository
  const memoryModules = composeDaemonMemoryModules({
    db,
    nodeRunPrompts,
    systemAgentBinding: memorySystemAgentBinding,
    contexts: identityAccess.contexts,
    reviewedArtifacts: {
      read: async (finalPath) =>
        await readCommittedReviewArtifactBody(taskExecutionProvider.collaboration, finalPath),
    },
  })
  const { memoryOperations, memoryCatalog } = memoryModules

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

  const taskExecutionModules: DaemonTaskExecutionModules<'sqlite'> =
    composeDaemonTaskExecutionModules({
      db,
      appHome: Paths.root,
      configPath: Paths.config,
      secretBox,
      taskLaunchConfiguration,
      adapters: DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({ db }),
      core: providerCore,
      observation: observationModules,
      resources: { ...resourceCatalogModules, owners: composeOwnerIdentityQueries(db) },
      repository: repositoryCredentials,
      memory: memoryModules,
      selection: {
        taskRunBinding: taskRunRoot.drive,
        workspaceExcludeProfilesFor,
        nodeRunPrompts,
        portArtifacts,
        isolationWorkspaces: input.isolationWorkspaces,
        repositoryGitWorkspaces: input.repositoryGitWorkspaces,
        archive: input.taskArchive,
        workspaceReads: input.workspaceReads,
        effects: input.taskDeletionEffects,
        workspaceUploads: input.workspaceUploads,
        preparationEffects: input.repositoryPreparationEffects,
        scratchEffects: input.scratchWorkspaceEffects,
        fusionWorkspaces: createFileFusionWorkspaceEffects({ appHome: Paths.root }),
      },
      alerts: { onAlert: broadcastAlert, onResolved: broadcastResolved },
      finalizeWorkspace: async (taskId) => {
        await workspaceMaintenance.finalizeClaimedWorkspace(taskId)
      },
    })
  const taskExecutionProvider = taskExecutionModules
  const taskExecutionResources = taskExecutionModules.resources
  const taskExecutionPersistence = taskExecutionProvider.persistence
  const taskExecutionRuntime = taskExecutionProvider.runtime
  const collaborationContext = taskExecutionProvider.collaboration
  const scheduledTaskModules = composeDaemonScheduledTaskModules({
    db,
    assertAgentIntegrity: (agentIds) =>
      agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
  })
  const { scheduledTaskRuntime } = scheduledTaskModules
  const integrationIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionResources,
  })
  const fusionModules = composeDaemonFusionModules({
    db,
    appHome: Paths.root,
    skillContent: input.skillContent,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.fusion,
    taskLaunchConfiguration,
  })
  const { fusionOperations } = fusionModules
  const mcpRuntimeTestBindings = createLazyPausableDaemonRuntimeServiceBindings({
    start: async () => {
      await mcpRuntimeTests.pause()
      await mcpRuntimeTests.resume()
    },
    runtimeId: 'mcp-runtime-tests',
    closeParticipantId: 'mcp-runtime-tests-final-close',
    service: {
      pause: () => mcpRuntimeTests.pause(),
      resume: () => mcpRuntimeTests.resume(),
      stop: () => mcpRuntimeTests.stop(),
    },
  })

  const workspaceMaintenance = composeWorkspaceMaintenanceCommand({
    filesystem: input.workspaceMaintenanceFilesystem,
    db,
    appHome: Paths.root,
    terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: invalidateCallGraphIndex,
  })
  // RFC-383: integration forwards to the same session instance as HTTP and the OS worker.
  const digitalEmployeeWorkStart = Object.freeze<DigitalEmployeeWorkStartPort>({
    launch: (request) => digitalEmployeeModules.workStart.launch(request),
  })
  const integrationModules = composeDaemonIntegrationModules({
    db,
    secretBox,
    configuration,
    scheduledTaskRuntime,
    identityAccess: integrationIdentityAccess,
    bindEventAutomationContexts: createEventAutomationDelegatedContextBinding,
    runtimeRegistry: taskExecutionProvider.executionModule.runtimeRegistry,
    workspaceMaintenance,
    taskExecutions: taskExecutionProvider.trigger.taskExecutions,
    digitalEmployeeWorkStart,
    developmentDeliveryProvider,
    developmentPurposeRoot,
    adapters: { customObserverPrograms: input.customObserverPrograms },
  })
  const {
    webhookTerminalControl,
    webhookDeliveryPersistence,
    webhookDispatcher,
    eventCenter: employeeHttpEventCenter,
  } = integrationModules
  const digitalEmployeeModules = composeDaemonDigitalEmployeeModules({
    db,
    appHome: Paths.root,
    configuration,
    log,
    typePackageDriftPolicy: digitalEmployeeTypePackageDriftPolicy,
    core: {
      daemonActor: providerCore.daemonActor,
      userDirectory: identityAccess.userDirectory,
      directAuthority: identityAccess.directAuthority,
    },
    resources: resourceCatalogModules,
    repository: repositoryCredentials,
    integration: integrationModules,
    taskExecution: taskExecutionModules,
    developmentPurposeRoot,
    workspaceEffects: developmentWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    evidenceArtifacts: input.evidenceArtifacts,
    repositoryCandidateEffects: input.repositoryCandidateEffects,
    conflictMergeWorkspaceEffects: input.conflictMergeWorkspaceEffects,
    adapters: {
      employeePrograms: input.employeePrograms,
      employeeInputArtifacts: input.employeeInputArtifacts,
      employeeCaseWorkspaceEffects: input.employeeCaseWorkspaceEffects,
    },
  })
  const developmentAutomationModules = composeDaemonDevelopmentAutomationModules({
    db,
    appHome: Paths.root,
    log,
    developmentPurposeRoot,
    workspaceEffects: developmentWorkspaceEffects,
    repository: repositoryCredentials,
    integration: integrationModules,
    hostTasks: taskExecutionModules.hostTasks,
    writerCutover: digitalEmployeeModules.writerCutover,
    verificationCommands: input.verificationCommands,
    repositoryBaselines: input.repositoryBaselines,
    evidenceRead: input.evidenceRead,
    attemptContext: input.attemptContext,
    repositoryCandidateEffects: input.repositoryCandidateEffects,
    conflictMergeWorkspaceEffects: input.conflictMergeWorkspaceEffects,
    missionInputBlobs: input.missionInputBlobs,
    evidenceArtifacts: input.evidenceArtifacts,
  })
  const intentModules = composeDaemonIntentModules({
    db,
    appHome: Paths.root,
    configuration,
    log,
    core: identityAccess,
    resources: resourceCatalogModules,
    observation: observationModules,
    digitalEmployee: digitalEmployeeModules,
  })
  const employeeEventCenter = employeeHttpEventCenter
  const employeeOs = digitalEmployeeModules.module
  const employeeWriterCutover = digitalEmployeeModules.writerCutover
  const employeeExecutionContracts = digitalEmployeeModules.executionContracts
  const digitalEmployeePlatformTools = digitalEmployeeModules.platformTools
  const employeeCaseDetailProjection = digitalEmployeeModules.caseDetailProjection
  const developmentAutomation = developmentAutomationModules.automation
  const developmentAdmissionLookup = developmentAutomationModules.admissionLookup

  const humanGateContinuationRecovery = createSqliteHumanGateContinuationRecoveryQueries(db)

  const humanGateContinuationWorkerDefinition = createHumanGateContinuationWorkerDefinition({
    listPending: () => humanGateContinuationRecovery.listPending(),
    drive: taskExecutionModules.gateContinuation,
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
    taskExecutionProvider.lifecycleProjector,
    createCollaborationWsProjector(createCollaborationCommittedEventProjection(db)),
  ]
  const committedEventProjectionLedger = createCommittedEventProjectionLedger()
  const committedEventPersistence = createCommittedEventDeliveryPersistence(db)
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
          if (taskExecutionModules.isTaskActive(taskId)) return
          await workspaceMaintenance.finalizeClaimedWorkspace(taskId)
        },
        async enqueueTaskRunDistill(taskId) {
          await memoryOperations.distillCommands.enqueue({
            sourceKind: 'task-run',
            sourceEventId: taskId,
            taskId,
          })
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
    async maxAttempts() {
      const current = await configuration.read()
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
        async drain() {
          if (!stopped) throw new Error('after-commit-event-pump-drain-before-stop')
          await committedEventPump.awaitDrained()
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
  // RFC-384: maintenance and HTTP observe the same session-owned apply engine.
  const intentMaintenanceSnapshots = intentModules.maintenance
  const intentQueuedResumption = intentModules.queuedResumption
  // RFC-359 —— 「本进程正在跑哪些 apply」的来源是 apply 引擎自己（与 PostgreSQL 同一条），
  // 不再是 legacy `services/bundle/apply` 的模块级集合。引擎在下面的 `composeSqliteAppDeps`
  // 里装出来，而维护服务先起——这里晚绑定：payload 每个 tick 才求值，那时装配早已完成。
  const maintenanceConfiguration = await configuration.read()
  const maintenanceService: ReturnType<typeof createMaintenanceService> = createMaintenanceService({
    // RFC-359 AC-10：装配方本来就知道自己在装哪个 provider，写出来。
    // 此前这里不写、由 `options.provider ?? 'sqlite'` 静默兜底——那是「落进 else」的另一种写法。
    provider: 'sqlite',
    // 本地库文件正在被快照时别发 WAL checkpoint——两者抢同一份文件。
    fileSnapshotInFlight: isDbSnapshotInProgress,
    // RFC-359 AC-10：准入存储与 Worker 监工都由**装配方**交出，服务体内不再问 provider。
    // 准入走自己的**短等待**本地连接：被争用的持久 INSERT 最多把一个槽位推迟一个监工 tick，
    // 永远不会占着 HTTP 事件循环上主连接历史上的那 5 秒。
    openAdmissionStore: (config) =>
      openSqliteMaintenanceAdmissionStore({
        dbPath: Paths.db,
        migrationsFolder,
        synchronous: config.sqliteSynchronous,
        pageCacheMib: config.sqlitePageCacheMib,
        mmapMib: config.sqliteMmapMib,
      }),
    startSupervisor: (config, handlers) =>
      startMaintenanceWorkerSupervisor({
        appHome: Paths.root,
        databaseInit: {
          dbPath: Paths.db,
          migrationsFolder,
          sqlite: {
            synchronous: config.sqliteSynchronous,
            pageCacheMib: config.sqlitePageCacheMib,
            mmapMib: config.sqliteMmapMib,
            busyTimeoutMs: 50,
          },
        },
        effectsBootstrap: input.maintenanceEffectsBootstrap,
        ...handlers,
      }),
    appHome: Paths.root,
    configPath: applicationConfiguration.notificationKey,
    loadConfig: () => maintenanceConfiguration,
    payloadSources: Object.freeze({
      activeTaskIds: activeTaskIdsSnapshot,
      activeIntentApplyJournalIds: intentMaintenanceSnapshots.activeApplyJournalIds,
      activeResourceBundleApplyIds: () =>
        appComposition.resourcePackageApplyActivity.activeApplyIds(),
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
    onIntentQueued: intentQueuedResumption.enqueue,
  })
  const maintenanceRuntimeBindings = createLazyPausableDaemonRuntimeServiceBindings({
    start: () => maintenanceService.start(),
    runtimeId: 'maintenance',
    closeParticipantId: 'maintenance-final-close',
    service: maintenanceService,
  })
  const codeHistoryQueries = composeCodeHistoryQueries(db)
  const databaseMigration = composeDatabaseMigrationModule({
    admission: migrationAdmission,
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

  // 7. HTTP receives the completed session bundles.
  const appComposition: SqliteAppComposition<typeof providerCore> = composeSqliteAppDeps({
    intentModules,
    digitalEmployeeModules,
    developmentAutomationModules,
    repositoryCredentials,
    resourceCatalogModules,
    observationModules,
    memoryModules,
    scheduledTaskModules,
    integrationModules,
    fusionModules,
    nodeRunPrompts,
    portArtifacts,
    taskRunSelection: input.taskRunSelection,
    developmentPurposes: input.developmentPurposes,
    developmentPurposeRoot,
    workspaceExcludeProfiles: input.workspaceExcludeProfiles,
    taskDeletionEffects: input.taskDeletionEffects,
    automationWorkspaceEffects: developmentWorkspaceEffects.automationWorkspaceEffects,
    actionWorkspaceEffects: developmentWorkspaceEffects.actionWorkspaceEffects,
    conflictMergeWorkspaceEffects: input.conflictMergeWorkspaceEffects,
    providerCore,
    token,
    executionAuthority: input.executionAuthority ?? composeLocalExecutionAuthority(),
    digitalEmployeePlatformTools,
    configPath: Paths.config,
    configuration,
    applicationConfiguration,
    daemonInfoPath: Paths.daemonInfo,
    daemonRuntime: input.daemonRuntime,
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
    workspacePresence,
    schedulerDriver: taskExecutionRuntime.schedulerDriver,
    taskExecutionReadModels: taskExecutionRuntime.readModels,
    taskExecutionModules,
    taskRouteLaunch: taskExecutionProvider.routeLaunch,
    taskArchiveMaintenance: taskExecutionProvider.archive,
    skillContent: input.skillContent,
    employeePrograms: input.employeePrograms,
    employeeInputArtifacts: input.employeeInputArtifacts,
    missionInputBlobs: input.missionInputBlobs,
    pluginInstaller: input.pluginInstaller,
    evidenceArtifacts: input.evidenceArtifacts,
    resourcePackageSkillArtifacts: input.resourcePackageSkillArtifacts,
    resourcePackagePluginArtifacts: input.resourcePackagePluginArtifacts,
    resourcePackageSkillContent: input.resourcePackageSkillContent,
    workspaceContent: input.workspaceContent,
    workspaceUploads: input.workspaceUploads,
    isolationWorkspaces: input.isolationWorkspaces,
    repositoryGitWorkspaces: input.repositoryGitWorkspaces,
    repositoryCandidateEffects: input.repositoryCandidateEffects,
    workspaceReads: input.workspaceReads,
    employeeCaseWorkspaceEffects: input.employeeCaseWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    verificationCommands: input.verificationCommands,
    evidenceRead: input.evidenceRead,
    evidenceDocumentCommands: input.evidenceDocumentCommands,
    attemptContext: input.attemptContext,
    memoryOperations,
    databaseMigration: databaseMigration,
    collaborationContext,
    mcpRuntimeTests,
    webhookDispatcher,
    webhookTerminalControl,
    digitalEmployeeEventCenter: employeeHttpEventCenter,
    digitalEmployeeCaseDetailProjection: employeeCaseDetailProjection,
    digitalEmployeeTypePackageDriftPolicy,
  })
  const app = createComposedApp(appComposition)

  const ws = buildWebSocketAdapter({
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
  const reverifyResourceContent = async () => {
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
      throw err
    }
  }

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
  // 而不是进 RFC-338 的维护 Worker，因为取消依赖进程内 scheduler 的
  // AbortController / driver stop ticket / WS 广播，Worker 线程拿不到。
  const idleTimeoutOperations = composeTaskIdleTimeoutOperations({
    persistence: createSqliteTaskIdleTimeoutPersistence(db),
    cancelTask: (taskId, reason) =>
      composeTaskCancellation(db).cancel(taskId, {
        kind: 'resource-reaped',
        ...reason,
      }),
  })
  const idleTimeoutRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'task-idle-timeout',
    intervalMs: DAEMON_CADENCE.taskIdleTimeout,
    // 每拍热读配置：开关与阈值改动免重启（AC-16）。
    async run() {
      await runTaskIdleTimeoutSweep(
        idleTimeoutOperations,
        (await configuration.read()).taskIdleTimeout,
      )
    },
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
    async start() {
      const current = await configuration.read()
      const ticker = startBackupScheduler({
        db,
        intervalMs: current.backupIntervalMs,
        retentionCount: current.backupRetentionCount,
        retentionDays: current.backupRetentionDays,
        maxTotalBytes: current.backupMaxTotalBytes,
        protectedKeepCount: current.backupProtectedKeepCount,
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
        async drain() {
          if (!stopped) throw new Error('scheduled-backup-drain-before-stop')
          await ticker.awaitIdle()
        },
      })
    },
  })
  // RFC-210 G7: keep cached mirrors (and their submodules) from going stale when
  // nobody launches a task against them. Reads its own enable flag each tick.
  const submoduleRefreshRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'submodule-refresh',
    async start() {
      const ticker = await startConfiguredSubmoduleRefreshLoop(
        repositoryWorkspaceStore,
        configuration,
        undefined,
        Paths.root,
        secretBox,
      )
      const unregister = registerConfigAppliedListener(
        applicationConfiguration.notificationKey,
        () => ticker.reconfigure().then(() => undefined),
      )
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          unregister()
          ticker.stop()
        },
        async drain() {
          if (!stopped) throw new Error('submodule-refresh-drain-before-stop')
          await ticker.awaitIdle()
        },
      })
    },
  })
  const batchImportRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'batch-import-gc',
    async start() {
      const ticker = startBatchImportGc(
        undefined,
        (await configuration.read()).repoBatchImportRetentionMs,
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
  // RFC-366: the ONE ambient provider the distill path needs. The admission gate
  // runs inside `enqueueDistillJob`, which is reached from clarify / review /
  // feedback / the two execution-end triggers, none of which have a config path
  // to thread. Re-reading here means a settings edit gates the very next event
  // instead of the next daemon restart (D10). A broken config file falls back to
  // the defaults (manual-only, every source on) rather than silently admitting
  // everything.
  //
  // RFC-366 T6/T8 (2026-09-22): this also carries RFC-050's `memoryDistillLang`
  // as `DistillPolicy.outputLang`. It used to be a second provider with its own
  // setter and its own `loadConfig` call, registered right here in BOTH engine
  // compositions — four registration sites for two knobs that are read at the
  // same instant, from the same file, by the same function. One provider now.

  // distill 的这几项**每 tick 重读**，与 PostgreSQL 路径（同文件 memory-distill
  // factory）逐字一致：之前这里是引导期快照（`distillBootConfig`），于是同一个设置
  // 在 PostgreSQL 上改完立刻生效、在 SQLite（零配置默认部署）上要重启 daemon 才生效
  // ——同一个旋钮两种语义。用户 2026-09-21 定：拉齐成热生效，memoryDistillerEnabled /
  // memoryDistillRuntime / memoryDistillModel / memoryDistillSourceContext /
  // memoryDistillTimeoutMs 五项一起。`loadConfig` 每次读盘，PG 路径本来就是这么做的。
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
      const current = await configuration.read()
      if (current.memoryDistillerEnabled === false) return
      await memoryOperations.distillWorker.tick({
        runtimeName: current.memoryDistillRuntime ?? null,
        defaultRuntime: current.defaultRuntime ?? null,
        model: current.memoryDistillModel ?? null,
        sourceContextBudget: resolveSourceContextBudget(current.memoryDistillSourceContext),
        timeoutMs: current.memoryDistillTimeoutMs,
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
  const developmentWakeRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'development-wake',
    intervalMs: DAEMON_CADENCE.developmentWakeSweep,
    run: () => developmentAutomationModules.sweepWakesWhileDraining(),
    onError(error) {
      log.warn('development wake sweep failed', {
        err: error instanceof Error ? error.message : String(error),
      })
    },
  })
  // Upload/input/retention sweeps remain RFC-338 Worker adapters.

  const employeeOsRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'digital-employee-os',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      const result = await runDigitalEmployeeOsCycle({ runtime: employeeOs.runtime.worker })
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
      await reconcileRunningFusions({ operations: fusionOperations })
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
      configuration,
      scheduled: {
        operations: scheduledTaskRuntime.operations,
        identityAccess: integrationIdentityAccess,
      },
    },
  )
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
      // Boot reconciliation is passive; arm the timer only on session resume.
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
  // RFC-359 W3-T14：与 PostgreSQL 会话同一组关闭参与者、同一顺序。此前这几步写在监听器的
  // `shutdown()` 里（先于 `bootstrap.stop()`），两条 serve 序列合一为 `serveDaemon` 后只剩会话这一种放法。
  const memoryDistillRecoverOnClose: DaemonProviderCloseParticipant = Object.freeze({
    id: 'memory-distill-recover-running',
    close: async () => {
      await memoryOperations.distillWorker.recoverRunning()
    },
  })
  const gracefulTaskShutdown: DaemonProviderCloseParticipant = Object.freeze({
    id: 'task-execution-graceful-shutdown',
    async close({ reason }: Parameters<DaemonProviderCloseParticipant['close']>[0]) {
      if (reason !== 'daemon-shutdown') return
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(
        {
          controller: createTaskExecutionShutdownController(taskExecutionModule),
          operations: taskExecutionPersistence.shutdown,
          recovery: taskExecutionPersistence.recoveryAdministration,
        },
        0,
      )
    },
  })
  const webhookTerminalClose: DaemonProviderCloseParticipant = Object.freeze({
    id: 'webhook-terminal-control',
    close: () => webhookTerminalControl.stop(),
  })
  const lifecycleProgram = composeDaemonLifecycle({
    provider: 'sqlite',
    profile: input.executionAuthority?.mode,
    log: input.log,
    steps: {
      'runtime-declarations': async () => {
        const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))
        if (notModeled.length > 0) {
          log.info('runtime declaration self-check: not-modeled dispositions', { notModeled })
        }
      },
      'process-registrations': async () => {
        registerTerminalWorkspacePrunePolicy(
          composeWebhookTerminalWorkspacePrunePolicy({
            db,
            enabled: async () => (await configuration.read()).webhookTaskWorkspaceAutoCleanup,
          }),
        )
        setMemoryDistillPolicyProvider(async () => {
          try {
            return resolveDistillPolicy(await configuration.read())
          } catch {
            return DEFAULT_DISTILL_POLICY
          }
        })
      },
      'repository-url-sealing': async () => {
        await ensureCredentialsSealed(repositoryWorkspaceStore, secretBox)
      },
      'transport-projections': async () => {
        await reconcileRepositoryTransportConnectionProjections(
          repositoryTransportRepository,
          repositoryTransportModule.adminConnections,
        )
      },
      'git-credential-lease-cleanup': async () => {
        const removedCredentialLeases = cleanupOrphanedGitCredentialLeases(Paths.root)
        if (removedCredentialLeases > 0) {
          log.info('orphaned git credential leases removed', { count: removedCredentialLeases })
        }
      },
      'daemon-identity': NotApplicable,
      'skill-identity-barrier': async () => {
        const report = await skillCatalogBoot.runIdentityMigrationBarrier()
        if (
          report.recoveredOperations > 0 ||
          report.removedHusks > 0 ||
          report.migratedSkills > 0
        ) {
          log.info('skill identity migration barrier complete', { ...report })
        }
      },
      'fusion-provenance': async () => {
        const { repairFusionProvenance } =
          await import('@/modules/knowledge-evolution/public/operations')
        const report = await repairFusionProvenance(fusionOperations.persistence)
        if (Object.values(report).some((count) => count > 0)) {
          log.info('fusion provenance repair complete', { ...report })
        }
      },
      'skill-availability-gate': async () => {
        skillCatalogBoot.activateAvailabilityGate()
      },
      'skill-live-files': async () => {
        await skillCatalogBoot.reconcileLiveFiles()
      },
      'task-delete-recovery': async () => {
        const deleteRecovery = await recoverInterruptedTaskDeletes(
          db,
          undefined,
          input.taskDeletionEffects,
        )
        if (
          deleteRecovery.completed.length > 0 ||
          deleteRecovery.cleanupPending.length > 0 ||
          deleteRecovery.recoveryRequired.length > 0
        ) {
          log.info('terminal task delete recovery', { ...deleteRecovery })
        }
      },
      'archive-recovery': async () => {
        const archiveRecovery = await taskExecutionProvider.archive.recover({
          archiveDir: Paths.taskArchiveDir,
          runsDir: Paths.runsDir,
          logsDir: Paths.logsDir,
        })
        if (archiveRecovery.promoted.length > 0 || archiveRecovery.discarded.length > 0) {
          log.info('terminal task archive recovery', { ...archiveRecovery })
        }
      },
      'frame-backfill': async () => {
        const { runFrameBackfillOnBoot } =
          await import('@/modules/task-execution/composition/frameBackfill')
        const backfill = await runFrameBackfillOnBoot({ db })
        if (!backfill.skipped) {
          log.info('rfc354 frame backfill completed on boot', {
            tasks: backfill.tasks,
            rowsUpdated: backfill.rowsUpdated,
            roundsUpdated: backfill.roundsUpdated,
            unreadableTasks: backfill.unreadableTasks.length,
            unresolvedRows: backfill.unresolvedRows,
          })
        }
      },
      'scheduled-payload-heal': async () => {
        const { healScheduledLaunchPayloads } = await import('@/services/scheduledTasks')
        const healed = await healScheduledLaunchPayloads(scheduledTaskRuntime.operations)
        if (healed.converted > 0 || healed.disabled > 0) {
          log.info('scheduled launch payloads healed', healed)
        }
      },
      'fusion-decision-recovery': async () => {
        const { recoverFusionDecisions } =
          await import('@/modules/knowledge-evolution/public/operations')
        const r = await recoverFusionDecisions(fusionOperations.persistence)
        if (r.rolledForward + r.rolledBack + r.rejectFailed > 0) {
          log.info('fusion decision recovery on boot', { ...r })
        }
      },
      'fusion-resource-seed': async () => {
        const { seedFusionResources } =
          await import('@/modules/knowledge-evolution/public/operations')
        await seedFusionResources(fusionOperations.persistence)
      },
      'demo-seed': async () => {
        const { seedDemoContent } = await import('@/services/demoSeed')
        const result = await seedDemoContent({
          resourceCatalog: composeDemoResourceCatalogSeedParticipant(db),
          codeCapability: composeCodeCapabilityDemoSeedParticipant(db),
        })
        if (result.seeded) log.info('demo content seeded (delete it and it stays deleted)')
      },
      'runtime-registry': async () => {
        await initializeRuntimeRegistryBoot({
          operations: runtimeRegistry,
          config,
          legacyConfiguration: runtimeLegacyConfiguration,
          onRecoverableFailure(error) {
            log.warn('builtin runtime seed/migration on boot failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          },
        })
      },
      'event-catalog': async () => {
        await employeeHttpEventCenter.initialize()
      },
      'employee-agent-templates': async () => {
        await ensureDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates)
      },
      'employee-tool-catalog': async () => {
        await digitalEmployeePlatformTools.load()
      },
      'employee-authoring-ready': async () => {
        await employeeOs.maintenance.ready()
      },
      'employee-writer-state': async () => {
        const writer = await employeeWriterCutover.activate()
        log.info('digital employee writer activated', { ...writer })
      },
      'task-execution-recovery': async () => {
        const taskExecutionLockProof = createDaemonRecoveryAuthorityProof(
          await readDaemonStartupRecoveryAuthority(lock, DAEMON_GENERATION),
        )
        await runTaskExecutionBootRecovery({
          recoveryEffects: selectLocalBootExecutionRecoveryFactory(input.bootExecutionRecovery),
          persistence: taskExecutionPersistence,
          runtimeSessionLeases,
          lockProof: taskExecutionLockProof,
          codeHostProbe: (descriptor) =>
            probeCodeHostMutation({
              descriptor,
              resolveConnection: (provider) => repositoryMetadataConnections.resolve(provider),
            }),
          log,
        })
      },
      'observation-interrupt': async () => {
        const interruptedCalls = await observationCalls.repairInterrupted(Date.now())
        if (interruptedCalls > 0)
          log.info('observation calls interrupted', { count: interruptedCalls })
      },
      'workspace-maintenance-recovery': async () => {
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
      },
      'mr-terminal-reconcile': async () => {
        await webhookTerminalControl.reconcileOnBoot()
      },
      'webhook-delivery-recovery': async () => {
        const recoveredDeliveries = await recoverInterruptedDeliveries(webhookDeliveryPersistence)
        if (recoveredDeliveries > 0) {
          log.info('webhook deliveries marked interrupted', { count: recoveredDeliveries })
        }
      },
      'legacy-mission-recovery': () => developmentAutomationModules.recoverWhileDraining(),
      'employee-upgrade-settlement': async () => {
        await employeeOs.maintenance.settleAutomaticUpgrades()
      },
      'maintenance-boot-snapshot': async () => {
        await maintenanceService.captureBootSnapshot()
      },
      'hosted-targeted-resume': async () => {
        /* The crewstation profile cannot select SQLite. */
      },
      'resource-reverify': reverifyResourceContent,
      'bootstrap-admin-hint': async () => {
        if (await providerCore.authRuntime.isBootstrapRequired())
          log.info(
            'first multi-user run? create your admin via `agent-workflow user create --admin --username <name>`',
          )
      },
    },
    runtimeJobs: {
      'intent-queued-resumption': intentQueuedResumption.runtimeFactory,
      'task-execution': taskExecutionBackgroundBindings.runtimeFactory,
      maintenance: maintenanceRuntimeBindings.runtimeFactory,
      'mcp-runtime-tests': mcpRuntimeTestBindings.runtimeFactory,
    },
    backgroundJobs: {
      'webhook-terminal-control': webhookTerminalControlRuntimeFactory,
      'after-commit-event-pump': afterCommitPumpFactory,
      'human-gate-continuation': humanGateContinuationRuntimeFactory,
      'committed-event-dispatcher': committedEventRuntimeFactory,
      'memory-distill': memoryDistillRuntimeFactory,
      'development-wake': developmentWakeRuntimeFactory,
      'digital-employee-os': employeeOsRuntimeFactory,
      'event-center': eventCenterRuntimeFactory,
      'fusion-reconcile': fusionReconcileRuntimeFactory,
      'resource-limits': limitsRuntimeFactory,
      'task-idle-timeout': idleTimeoutRuntimeFactory,
      'scheduled-backup': backupRuntimeFactory,
      'submodule-refresh': submoduleRefreshRuntimeFactory,
      'batch-import-gc': batchImportRuntimeFactory,
    },
    closeParticipants: {
      'memory-distill-recover-running': memoryDistillRecoverOnClose,
      'task-execution-final-close': taskExecutionBackgroundBindings.closeParticipant,
      'maintenance-final-close': maintenanceRuntimeBindings.closeParticipant,
      'mcp-runtime-tests-final-close': mcpRuntimeTestBindings.closeParticipant,
      'task-execution-graceful-shutdown': gracefulTaskShutdown,
      'webhook-terminal-control': webhookTerminalClose,
    },
  })
  await lifecycleProgram.initialize(input.initializeExecution)
  const initialProviderSession = await _createComposedDaemonProviderRuntimeSession({
    provider: 'sqlite',
    generationId: lifecycle.generationId,
    ...executionActivationOf(input),
    app,
    webSocket: ws,
    lifecycle: lifecycleProgram,
    readyOnResume: input.lifecycle.operationId !== 'daemon-start',
    shutdownIdentity: () => identityAccess.shutdown(),
    closeProvider: () => databaseProvider.close(),
  })
  return Object.freeze({
    application: Object.freeze({ core: providerCore }),
    session: initialProviderSession,
  })
}

export function readyBrowserUrl(
  baseUrl: string,
  token: string,
  bootstrapRequired: boolean,
): string {
  return bootstrapRequired ? `${baseUrl}?token=${token}` : baseUrl
}
