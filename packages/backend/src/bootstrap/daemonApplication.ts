// RFC-391 — one passive application graph for daemon and unstarted phases.
import {
  DAEMON_SESSION_ADAPTERS,
  type DaemonSessionAdapter,
  type DaemonApplicationProvider,
  type DaemonApplicationDatabase,
} from './daemonSessionAdapters'
import type { ProviderAppOwnerInput } from '@/server'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import { DEFAULT_DISTILL_POLICY, resolveDistillPolicy } from '@agent-workflow/shared'
import { setMemoryDistillPolicyProvider } from '@/modules/memory/composition'
import { getRuntimeDriver, RUNTIME_KINDS } from '@/services/runtime'
import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'
import {
  initializeRuntimeRegistryBoot,
  type RuntimeLegacyConfigurationPort,
} from '@/modules/runtime-management/composition/runtimeRegistry'
import { composeDaemonIntentModules, type DaemonIntentModules } from '@/cli/daemonModules/intent'
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
import { createEventAutomationDelegatedContextBinding } from '@/modules/identity-access/composition'
import {
  composeDaemonScheduledTaskModules,
  type DaemonScheduledTaskModules,
} from '@/cli/daemonModules/scheduledTasks'
import {
  composeDaemonIntegrationModules,
  type DaemonIntegrationModules,
} from '@/cli/daemonModules/integration'
import { composeDaemonFusionModules, type DaemonFusionModules } from '@/cli/daemonModules/fusion'
import { standaloneModuleAdapters } from '@/cli/daemonModules/adapters'
import { composeDaemonMemoryModules } from '@/cli/daemonModules/memory'
import { composeDaemonObservationModules } from '@/cli/daemonModules/observation'
import {
  composeDaemonProviderCore,
  type SelectedDaemonProviderCore,
} from '@/cli/daemonModules/providerCore'
import { composeDaemonRepositoryCredentials } from '@/cli/daemonModules/repositoryCredentials'
import { composeDaemonResourceCatalogModules } from '@/cli/daemonModules/resourceCatalog'
import {
  DAEMON_BOOT_STEPS,
  NotApplicable,
  type DaemonBootStepId,
  type DaemonBootSteps,
  type DaemonBootStepDeclaration,
} from '@/cli/daemonLifecycleProgram'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/composition'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/composition'
import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
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
  composeLocalExecutionAuthority,
  readDaemonStartupRecoveryAuthority,
  type DaemonStartupLease,
} from '@/modules/system-operations/composition'
import type { CredentialAdapterSelection } from '@/modules/identity-access/composition/authentication'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import type {
  ApplicationConfigurationQueries,
  DaemonRuntimeQueries,
} from '@/modules/system-operations/public/queries'
import {
  type EmployeeCaseWorkspaceEffectsFactory,
  type RepositoryRemoteEffects,
  type WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import { type ScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import type { ActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionRunners'
import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'
import type { DigitalEmployeeModuleWithRuntime } from '@/modules/digital-employee/composition'
import { recoverInterruptedTaskDeletes } from '@/services/taskDelete'
import {
  createDaemonRecoveryAuthorityProof,
  runTaskExecutionBootRecovery,
  type BootExecutionRecoveryFactory,
} from '@/modules/task-execution/composition/bootRecovery'
import { selectLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import type { Config } from '@agent-workflow/shared'
import { join } from 'node:path'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import type { SecretBox } from '@/auth/secretBox'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { type RuntimeDiagnosticDependencies } from '@/modules/runtime-management/composition/runtimeManagement'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import { type WebhookDispatcher } from '@/services/webhook/dispatcherTypes'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import { reconcileRepositoryTransportConnectionProjections } from '@/modules/source-control/composition'
import type { CodeReviewArtifactStore } from '@/modules/code-capability/public/participants'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import type { composePostgresqlMemoryOperations } from '@/modules/memory/composition'
import { type PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import {
  type ResourcePackageSkillArtifactOwner,
  type ResourcePackagePluginArtifactOwner,
  type SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import {
  type SelectedTaskExecutionProviderRuntime,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
  type WorkspacePresenceQueries,
} from '@/modules/source-control/public/queries'
import { readCommittedReviewArtifactBody } from '@/modules/collaboration/public/queries'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition'
import { composeResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import {
  composeTaskIdleTimeoutOperations,
  createTaskIdleTimeoutPersistence,
  type TaskIdleTimeoutOperations,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import type {
  composeDevelopmentAutomation,
  EvidenceDocumentCommands,
  EvidenceArtifactPort,
  AttemptContextStorePort,
} from '@/modules/development-automation/composition'
import { type MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'
import type { composeMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'
import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import { type CustomObserverProgramFactory } from '@/modules/event-center/composition'
import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { composeWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { cleanupOrphanedGitCredentialLeases } from '@/util/gitCredentialLease'
import { recoverInterruptedDeliveries } from '@/services/webhook/deliveryStore'
import { Paths } from '@/util/paths'
import { composeDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { materializingSpaces } from '@/services/gc'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'
import { runFrameBackfillOnBoot } from '@/modules/task-execution/composition/frameBackfill'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import type { DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import {
  composeProviderAppComposition,
  composeProviderAppDeps,
  createComposedApp,
  type UnstartedApplicationScope,
  type ProviderAppCompositionInput,
} from '@/server'
import { buildWebSocketAdapter } from '@/ws/server'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { PRESENCE_CHANNEL, presenceBroadcaster } from '@/ws/broadcaster'
import { composeDaemonRealtimePolicy } from '@/cli/daemonRealtimePolicy'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { type SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'

export interface DaemonApplicationInput<P extends DatabaseProvider = DatabaseProvider> {
  readonly digitalEmployeeTypePackageDriftPolicy?: 'reject' | 'draft-overlay'
  readonly provider: DaemonApplicationProvider<P>
  readonly db: DaemonApplicationDatabase<P>
  readonly config: Config
  readonly log?: ReturnType<typeof createLogger>
  readonly runtimeLegacyConfiguration?: RuntimeLegacyConfigurationPort
  readonly dbPath?: string
  readonly token: string
  readonly appHome: string
  readonly configPath: string
  readonly configuration?: ApplicationConfigurationQueries
  readonly applicationConfiguration?: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration?: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly taskArchive?: TaskArchiveContentBinding
  readonly skillContent?: SkillContentBinding
  readonly employeePrograms?: ProgramArtifactPort
  /** RFC-370 §10 V19: the hosted task-image fixture run; standalone runs on this host. */
  readonly programFixtureProcess?: ScriptFixtureProcess
  /** RFC-370 §10 V18: entry checks below a hosted action workspace; standalone checks its disk. */
  readonly actionWorkspaceEntries?: ActionWorkspaceEntries
  /** RFC-370 §10 V16: code-review reads of a hosted task volume; standalone reads its worktree. */
  readonly repositoryRevisionContent?: RepositoryRevisionContentFactory
  /** RFC-370 §10 V16: hosted code-review artifacts; standalone keeps appHome files. */
  readonly codeReviewArtifacts?: CodeReviewArtifactStore
  readonly employeeInputArtifacts?: EmployeeInputArtifactPort
  readonly missionInputBlobs?: MissionInputBlobPersistence
  readonly pluginInstaller?: PluginInstallerPort
  readonly beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  readonly databaseBackup?: DatabaseBackupEffects
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly intentArtifacts?: IntentArtifactSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  readonly resourcePackageSkillContent?: SkillPackageContentReader
  readonly workspaceContent?: WorkspaceContentEffectsFactory
  /** RFC-370 §10 V17: hosted repository remote reads (system volume); absent, local mirrors. */
  readonly repositoryRemote?: RepositoryRemoteEffects
  readonly workspaceUploads?: WorkspaceUploadContentFactory
  readonly isolationWorkspaces?: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  readonly repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  readonly employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
  readonly verificationCommands?: VerificationCommandEffectsFactory
  readonly customObserverPrograms?: CustomObserverProgramFactory
  readonly bootExecutionRecovery?: BootExecutionRecoveryFactory
  /** RFC-370 v2 H7: bootstrap selects the execution authority; standalone by default. */
  readonly executionAuthority?: ExecutionAuthorityPort
  /** RFC-370 v2 §3.6: bootstrap selects the credential mechanism; standalone by default. */
  readonly credentials?: CredentialAdapterSelection
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  readonly taskDeletionEffects?: TaskDeletionEffects
  /** RFC-370 §9.2 V3: a hosted publication's network Git runs in its task volume. */
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  readonly nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  readonly portArtifactContentEffects?: PortArtifactContentEffects
  readonly runtimeInventoryContent?: TaskRuntimeInventoryContent
  readonly taskRunSelection?: TaskRunRootSelection
  readonly taskRecovery?: TaskRecoveryDeploymentSelection
  readonly taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20: the fusion engine task's workspace; standalone under appHome. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
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
  readonly evidenceRead?: EvidenceReadBinding
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
  readonly attemptContext?: AttemptContextStorePort
  readonly daemonInfoPath: string
  readonly daemonRuntime?: DaemonRuntimeQueries
  readonly daemonStartupLease?: DaemonStartupLease
  readonly lockPath: string
  readonly secretBox: SecretBox
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly workspaceReads?: RepositoryWorkspaceReadQueries
  /** RFC-349 T10 — see `DatabaseSourceWriteWindow`; bootstrap supplies the live one. */
  readonly sourceWriteWindow?: DatabaseSourceWriteWindow
  readonly databaseMigration: DatabaseMigrationModule
  readonly dbVersion: number
  /**
   * RFC-159 / RFC-359 —— 覆盖定时任务 run-now 的启动闭包。生产不传（下面从
   * `taskExecutionProvider.trigger` 取真的那个），测试注入桩，免得
   * POST /:id/run-now 真去 spawn 一个 opencode 任务。
   *
   * 为什么补这个口子：SQLite 根**早就有**同形的可选覆盖（`server.ts` 的
   * `buildScheduleLaunch?`，取值处 `deps.buildScheduleLaunch ?? …`），PG 根却没有
   * ——两个组合根的**装配签名不对称**，而它恰好挡住 `scheduled-tasks-run-now`
   * 的 AC-6 双引擎迁移。补成同形（默认值不变）比在测试里给 PG 开特例分支干净。
   */
  readonly buildScheduleLaunch?: BuildScheduleLaunch
  /**
   * RFC-284 T26 / RFC-359 —— 运行时诊断的测试注入口（生产两侧都省略）。
   *
   * 与 `buildScheduleLaunch` 同理：`RuntimesRouteDependencies`
   * （`routes/runtimes.ts`）**本来就**声明了这个可选字段，SQLite 根也一直从
   * `deps` 透传进去；PG 根只是没把它从自己的入参转下去，于是同一批运行时诊断
   * 用例在 PG 上没法双跑。这里补的是一次纯透传，不改任何默认行为。
   */
  readonly runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticDependencies>
  /**
   * RFC-257 / RFC-359 —— 覆盖 webhook 派发器。生产两侧都省略（PG 根自己构造、
   * SQLite 根由 `cli/start.ts` 注入真的那个）；测试注入桩，免得真的去投递。
   *
   * 与另外两个覆盖口不同：两个根对它的**所有权**本来就不同，所以这里不是简单透传
   * ——覆盖件只有部分能力时，事件中心那几处按 `supports*` 探测降级，与 `server.ts`
   * 对同一件事的做法逐字同构。见 plan §5bi。
   */
  readonly webhookDispatcher?: WebhookDispatcher
  /**
   * RFC-238 / RFC-359 —— MCP 运行时测试的测试接缝。生产两侧都省略（用真的 runner 与真时钟）。
   *
   * 与 `runtimeDiagnosticTestDependencies` 同类：SQLite 根一直把这三项条件展开进
   * `composeLocalMcpDiagnostics(...)`（`server.ts` 的 `runFn` / `now` / `capacity`），
   * PG 根建的是**同一个**服务却没转发它们，于是同一批用例在 PG 上没法双跑。
   * `appHome` 不在这里——PG 根本来就从 `input.appHome` 取。
   */
  readonly mcpRuntimeTestDependencies?: {
    readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    readonly now?: () => number
    readonly capacity?: number
  }
  /**
   * RFC-234 / RFC-359 —— 意图回合的 system-agent 运行接缝。生产两侧都省略。
   * 与 MCP 那一个同理：`IntentSessionRouteDependencies` 本来就有 `runTurn`，
   * SQLite 根一直条件展开进去（`server.ts:2750-2752`），PG 根没转发。
   */
  readonly intentTestDependencies?: {
    readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
  readonly maintenanceStatus?: NonNullable<
    ProviderAppCompositionInput<P>['platform']['maintenance']['maintenanceStatus']
  >
  readonly workflowRuntime?: ProviderAppCompositionInput<P>['resourceCatalog']['workflows']['runtime']
  readonly opencodeVersion?: string | null
}

export type DaemonApplicationPhase =
  | { readonly kind: 'daemon' }
  | { readonly kind: 'unstarted'; readonly scope: UnstartedApplicationScope }

export interface DaemonApplication<P extends DatabaseProvider = DatabaseProvider> {
  readonly modules: ProviderAppOwnerInput<P>['modules']
  readonly operations: {
    readonly workspaceMaintenance: ReturnType<typeof composeWorkspaceMaintenanceCommand>
    readonly resourceLimits: ReturnType<typeof composeResourceLimitOperations>
    readonly taskIdleTimeout: TaskIdleTimeoutOperations
    readonly integrationIdentityAccess: ProviderAppOwnerInput<P>['integrationIdentityAccess']
    readonly resourcePackageApplyActivity: DaemonApplicationRuntime<P>['resourcePackageActivity']
  }
  readonly lifecycleSteps: Omit<DaemonBootSteps, 'maintenance-boot-snapshot'>
  readonly core: SelectedDaemonProviderCore<P>
  readonly app: ReturnType<typeof createComposedApp>
  readonly webSocket: ReturnType<typeof buildWebSocketAdapter>
  readonly runtime: DaemonApplicationRuntime<P>
}

/**
 * Closed daemon-lifetime participants selected together with the HTTP graph.
 * The start command owns timers and workers; it receives no route dependency
 * builders and cannot accidentally re-compose a second provider graph.
 */
export interface DaemonApplicationRuntime<P extends DatabaseProvider = DatabaseProvider> {
  readonly taskExecutionModules: DaemonTaskExecutionModules<P>
  readonly taskExecution: SelectedTaskExecutionProviderRuntime
  /**
   * RFC-359 —— 装配好的协作命令上下文。暴露它不是为了给 daemon 用（daemon 不碰它），
   * 而是为了让**测试夹具能把应用自己建的那一份交给用例**。合一前一批用例为了拿到它，
   * 在外面用 `createCollaborationCommandContext({...})` 再建一份一模一样的、再从
   * `AppDeps.collaborationContext` 塞回去——那个形状把用例钉死在 SQLite 上。
   */
  readonly collaborationContext: CollaborationRouteContext
  readonly scheduledTasks: DaemonScheduledTaskModules['scheduledTaskRuntime']
  readonly scheduledTaskIdentityAccess: TaskExecutionBackgroundStartDependencies['scheduled']['identityAccess']
  readonly memory: ReturnType<typeof composePostgresqlMemoryOperations>
  readonly developmentAutomation: ReturnType<typeof composeDevelopmentAutomation>
  readonly digitalEmployee: DigitalEmployeeModuleWithRuntime
  readonly digitalEmployeeModules: DaemonDigitalEmployeeModules
  readonly developmentAutomationModules: DaemonDevelopmentAutomationModules
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly eventCenter: DaemonIntegrationModules['eventCenter']
  readonly fusion: DaemonFusionModules['fusionOperations']
  readonly resourceLimits: ReturnType<typeof composeResourceLimitOperations>
  /** RFC-350：不活跃超时收割（僵尸任务）的 provider-bound operations。 */
  readonly taskIdleTimeout: TaskIdleTimeoutOperations
  readonly mcpRuntimeTests: ReturnType<typeof composeLocalMcpDiagnostics>
  readonly webhookTerminalControl: ReturnType<typeof composeMrTerminalControl>
  readonly workspaceMaintenance: ReturnType<typeof composeWorkspaceMaintenanceCommand>
  readonly intentModules: DaemonIntentModules
  readonly resourcePackageActivity: Pick<
    ReturnType<typeof createPostgresqlResourcePackageAtomicApplyOperations>,
    'activeApplyIds'
  >
  readonly driveHumanGateContinuation: (input: {
    readonly taskId: string
    readonly continuationRef: string
  }) => Promise<void>
}

export async function composeDaemonApplication<P extends DatabaseProvider>(
  input: DaemonApplicationInput<P>,
  phase: DaemonApplicationPhase,
): Promise<DaemonApplication<P>> {
  const adapter = DAEMON_SESSION_ADAPTERS[input.provider.provider] as DaemonSessionAdapter<P>
  adapter.admitSelections(input)
  const log = input.log ?? createLogger('daemon')
  const developmentPurposeRoot = composeDevelopmentPurposeRoot({
    appHome: input.appHome,
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
      ? composeNodeRunPromptOperations(
          input.nodeRunPromptContentEffects,
          join(input.appHome, 'runs'),
        )
      : selectedTaskRuns.nodeRunPrompts
  const workspaceUploads = selectWorkspaceUploadContentFactory(input.workspaceUploads)
  const isolationWorkspaces = selectIsolationWorkspaceFactory(input.isolationWorkspaces)
  const repositoryGitWorkspaces = selectRepositoryGitWorkspaceFactory(input.repositoryGitWorkspaces)
  const workspaceReads = selectRepositoryWorkspaceReadQueries(input.workspaceReads)
  const developmentWorkspaceEffects = selectDevelopmentWorkspaceEffectBinding({
    actionWorkspaceEffects: input.actionWorkspaceEffects,
    automationWorkspaceEffects: input.automationWorkspaceEffects,
    conflictWorkspaceSelected: input.conflictMergeWorkspaceEffects !== undefined,
  })
  const portArtifacts =
    selectedTaskRuns === undefined
      ? composePortArtifactOperations(input.portArtifactContentEffects, input.appHome)
      : selectedTaskRuns.portArtifacts
  const taskRunRoot =
    selectedTaskRuns === undefined
      ? composeLocalTaskRunRootSelection({ nodeRunPrompts, portArtifacts })
      : selectedTaskRuns
  const applicationConfiguration =
    input.applicationConfiguration ??
    composeApplicationConfigurationBinding({
      kind: 'file',
      configPath: input.configPath,
      ...(input.configuration === undefined ? {} : { queries: input.configuration }),
    })
  const configuration = applicationConfiguration.queries
  const taskLaunchConfiguration =
    input.taskLaunchConfiguration ??
    composeTaskLaunchConfiguration(
      input.applicationConfiguration !== undefined ||
        applicationConfiguration.synchronousQueries === undefined
        ? { kind: 'selected', queries: configuration }
        : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
    )
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
  const core = composeDaemonProviderCore({
    daemonToken: input.token,
    db: input.db,
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.sourceWriteWindow === undefined
      ? {}
      : { sourceWriteWindow: input.sourceWriteWindow }),
    adapters: adapter.core(input),
    appHome: input.appHome,
    secretBox: input.secretBox,
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
  // Cold restore is a provider boot hook, not an HTTP/background operation.
  // Apply it while admission is still closed and before any owner module reads
  // the selected schema. A live non-empty target is rejected by the restore
  // coordinator; bootstrap never drops or aliases the active schema.
  if (phase.kind === 'daemon') {
    await adapter.afterCore(core)
  }

  const identityAccess = core.identityAccess
  const standalone = standaloneModuleAdapters()
  const observationModules = composeDaemonObservationModules({
    db: input.db,
    appHome: input.appHome,
    configuration,
    notificationKey: applicationConfiguration.notificationKey,
    identityAccess,
    daemonActor: core.daemonActor,
    runtimeRegistry: core.runtimeRegistry,
    mcpCatalog: () => mcpCatalog,
    adapters: {
      ...standalone,
      systemAgentRunFamily: input.systemAgentRunFamily ?? standalone.systemAgentRunFamily,
      mcpDiagnostics:
        phase.kind === 'daemon'
          ? (input.mcpDiagnostics ?? standalone.mcpDiagnostics)
          : phase.scope.createMcpRuntimeTests,
      runtimeManagement: input.runtimeManagement ?? standalone.runtimeManagement,
      workspacePresence: () => input.workspacePresence ?? standalone.workspacePresence(),
    },
    mcpRuntimeTestDependencies: input.mcpRuntimeTestDependencies,
    runtimeDiagnosticTestDependencies: input.runtimeDiagnosticTestDependencies,
  })
  const { observationCalls, memorySystemAgentBinding, runtimeSessionLeases, mcpRuntimeTests } =
    observationModules
  const resourceCatalogModules = composeDaemonResourceCatalogModules({
    db: input.db,
    skillContentRoot: input.appHome,
    skillContent: input.skillContent,
    pluginInstaller: input.pluginInstaller,
    runtimeProfiles: { get: (name) => core.runtimeRegistry.getRuntime(name) },
    mcpRuntime: {
      prepareDelete: (id) => mcpRuntimeTests.prepareMcpDelete(id),
      reconcileDurableIntents: () => mcpRuntimeTests.reconcileDurableIntents(),
    },
  })
  const {
    resourceCatalog,
    agentResourceIntegrity,
    skillCatalogBoot,
    mcpCatalog,
    digitalEmployeeAgentTemplates,
  } = resourceCatalogModules
  const repositoryCredentials = composeDaemonRepositoryCredentials({
    db: input.db,
    appHome: input.appHome,
    secretBox: input.secretBox,
    developmentPurposeRoot,
    repositoryWorkspaceStore: core.repositoryWorkspaceStore,
    repositoryWorkspaceOperations: core.repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository: core.repositoryTransportCredentialRepository,
    repositoryPublicationTransport: input.repositoryPublicationTransport,
    developmentWorkspaceRepositoryPreparation: input.developmentWorkspaceRepositoryPreparation,
  })
  const { repositoryTransport, codeHostConnections, developmentDeliveryProvider } =
    repositoryCredentials
  const repositoryTransportRepository = core.repositoryTransportCredentialRepository
  const memoryModules = composeDaemonMemoryModules({
    db: input.db,
    nodeRunPrompts,
    systemAgentBinding: memorySystemAgentBinding,
    contexts: identityAccess.contexts,
    reviewedArtifacts: {
      read: async (finalPath) =>
        await readCommittedReviewArtifactBody(boundCollaborationContext, finalPath),
    },
  })
  const { memoryOperations, memoryCatalog } = memoryModules
  const taskExecutionModules: DaemonTaskExecutionModules<P> = composeDaemonTaskExecutionModules({
    db: input.db,
    appHome: input.appHome,
    configPath: input.configPath,
    secretBox: input.secretBox,
    taskLaunchConfiguration,
    adapters: adapter.taskExecution(input),
    core,
    observation: observationModules,
    resources: {
      ...resourceCatalogModules,
      owners: composeOwnerIdentityQueries(input.db),
    },
    repository: repositoryCredentials,
    memory: memoryModules,
    selection: {
      taskRunBinding: taskRunRoot.drive,
      workspaceExcludeProfilesFor,
      nodeRunPrompts,
      portArtifacts,
      isolationWorkspaces,
      repositoryGitWorkspaces,
      archive: input.taskArchive,
      workspaceReads,
      effects: input.taskDeletionEffects,
      archivedEvents: input.archivedNodeEvents,
      reviewArtifacts: input.reviewArtifacts,
      reviewRollbackSnapshots: input.reviewRollbackSnapshots,
      workspaceUploads,
      inputFiles: input.taskInputFiles,
      preparationEffects: input.repositoryPreparationEffects,
      scratchEffects: input.scratchWorkspaceEffects,
      recoverySelection: input.taskRecovery?.(identityAccess),
      fusionWorkspaces:
        input.fusionWorkspaceEffects ??
        createFileFusionWorkspaceEffects({ appHome: input.appHome }),
    },
    alerts: {
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
    finalizeWorkspace: (taskId) => workspaceMaintenance.finalizeClaimedWorkspace(taskId),
  })
  const taskExecutionProvider = taskExecutionModules
  const taskExecutionResources = taskExecutionModules.resources
  const taskExecutionPersistence = taskExecutionModules.persistence
  const boundCollaborationContext = taskExecutionModules.collaboration
  const workspaceMaintenance = composeWorkspaceMaintenanceCommand({
    filesystem: input.workspaceMaintenanceFilesystem,
    db: input.db,
    appHome: input.appHome,
    terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: invalidateCallGraphIndex,
  })

  const fusionModules: DaemonFusionModules = composeDaemonFusionModules({
    db: input.db,
    appHome: input.appHome,
    skillContent: input.skillContent,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.fusion,
  })
  const { fusionOperations } = fusionModules
  // RFC-223 PR-4 / RFC-359 W3-T15：融合 provenance 修复必须在任何融合恢复 / 播种 / HTTP 观察到历史
  // name-only 行之前完成。fail-closed：不包 try，修复失败即 daemon 不起（两种 provider 共用）。
  const scheduledTaskModules = composeDaemonScheduledTaskModules({
    db: input.db,
    assertAgentIntegrity: (agentIds) =>
      agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
  })
  const { scheduledTaskRuntime } = scheduledTaskModules
  const integrationIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionResources,
  })
  const digitalEmployeeWorkStart = Object.freeze<DigitalEmployeeWorkStartPort>({
    launch: (request) => digitalEmployeeModules.workStart.launch(request),
  })
  const integrationModules = composeDaemonIntegrationModules({
    db: input.db,
    secretBox: input.secretBox,
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
    adapters: {
      customObserverPrograms: input.customObserverPrograms,
      beforeEventObservationWrite: input.beforeEventObservationWrite,
      crewStationEvents: input.crewStationEvents,
      webhookDispatcher: input.webhookDispatcher,
    },
  })
  const { webhookTerminalControl, eventCenter } = integrationModules
  const digitalEmployeeModules = composeDaemonDigitalEmployeeModules({
    db: input.db,
    appHome: input.appHome,
    configuration,
    log,
    typePackageDriftPolicy: input.digitalEmployeeTypePackageDriftPolicy,
    core: {
      daemonActor: core.daemonActor,
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
      programFixtureProcess: input.programFixtureProcess,
    },
  })
  const developmentAutomationModules = composeDaemonDevelopmentAutomationModules({
    db: input.db,
    appHome: input.appHome,
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
    actionWorkspaceEntries: input.actionWorkspaceEntries,
  })
  const digitalEmployee = digitalEmployeeModules.module
  const digitalEmployeePlatformTools = digitalEmployeeModules.platformTools
  const employeeWriterCutover = digitalEmployeeModules.writerCutover
  const developmentAutomation = developmentAutomationModules.automation
  // RFC-368 实现门 P2-1：资源上限与空闲收割都带真实原因取消（`resource-reaped`），状态与原因
  // 同一次写入落下——此前按 `user` 取消、事后改写原因，中间几秒像是用户取消的。
  const resourceLimitOperations = composeResourceLimitOperations({
    db: input.db,
    cancelTask: (taskId, reason) =>
      taskExecutionProvider.cancellation.cancel({
        taskId,
        cause: { kind: 'resource-reaped', ...reason },
      }),
  })
  const taskIdleTimeoutOperations = composeTaskIdleTimeoutOperations({
    persistence: createTaskIdleTimeoutPersistence(input.db),
    cancelTask: (taskId, reason) =>
      taskExecutionProvider.cancellation.cancel({
        taskId,
        cause: { kind: 'resource-reaped', ...reason },
      }),
  })
  const intentModules = composeDaemonIntentModules({
    db: input.db,
    appHome: input.appHome,
    configuration,
    log,
    core: identityAccess,
    resources: resourceCatalogModules,
    observation: observationModules,
    digitalEmployee: digitalEmployeeModules,
    adapters: {
      intentArtifacts: input.intentArtifacts,
      httpTurnFixture: input.intentTestDependencies?.runFn,
    },
  })
  const http = composeProviderAppComposition({
    db: input.db,
    token: input.token,
    appHome: input.appHome,
    secretBox: input.secretBox,
    dbVersion: input.dbVersion,
    opencodeVersion: phase.kind === 'daemon' ? null : (input.opencodeVersion ?? null),
    applicationConfiguration,
    executionAuthority: input.executionAuthority ?? composeLocalExecutionAuthority(),
    databaseTelemetry: input.provider.telemetry,
    maintenanceStatus: input.maintenanceStatus,
    daemonRuntime: input.daemonRuntime,
    daemonInfoPath: input.daemonInfoPath,
    databaseMigration: input.databaseMigration,
    portArtifacts,
    integrationIdentityAccess,
    modules: {
      core,
      repository: repositoryCredentials,
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
      resourcePackageSkillArtifacts: input.resourcePackageSkillArtifacts,
      resourcePackagePluginArtifacts: input.resourcePackagePluginArtifacts,
      resourcePackageSkillContent: input.resourcePackageSkillContent,
      workspaceContent: input.workspaceContent,
      runtimeInventoryContent: input.runtimeInventoryContent,
      repositoryRevisionContent: input.repositoryRevisionContent,
      codeReviewArtifacts: input.codeReviewArtifacts,
      repositoryRemote: input.repositoryRemote,
    },
    testSeams: {
      workflowRuntime: phase.kind === 'daemon' ? undefined : input.workflowRuntime,
      buildScheduleLaunch: input.buildScheduleLaunch,
    },
  })
  // RFC-359 W3-T4（P0-3 / P0-4）：boot 恢复四步与 SQLite 同一段序列（composition/bootRecovery.ts）——
  // 撤销旧 daemon 的 owner → 收割孤儿 run → 修 runtime session lease → 清算 effect 并释放 / 闭合 owner。
  // 必须在 HTTP 与任何自动续跑之前；此前 PG daemon 从未跑过，重启一次就把上一代任务永久卡在 running。
  const lifecycleSteps: DaemonApplication<P>['lifecycleSteps'] = {
    'runtime-declarations': async () => {
      const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))
      if (notModeled.length > 0) {
        log.info('runtime declaration self-check: not-modeled dispositions', { notModeled })
      }
    },
    'runtime-registry': async () => {
      await initializeRuntimeRegistryBoot({
        operations: core.runtimeRegistry,
        config: input.config,
        legacyConfiguration: requireRuntimeLegacyConfiguration(input.runtimeLegacyConfiguration),
        onRecoverableFailure(error) {
          log.warn('builtin runtime seed/migration on boot failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        },
      })
    },
    'process-registrations': async () => {
      registerTerminalWorkspacePrunePolicy(
        composeWebhookTerminalWorkspacePrunePolicy({
          db: input.db,
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
    'repository-url-sealing': providerBootStep(
      input.provider.provider,
      'repository-url-sealing',
      async () => {
        await ensureCredentialsSealed(core.repositoryWorkspaceStore, input.secretBox)
      },
    ),
    'transport-projections': async () => {
      await reconcileRepositoryTransportConnectionProjections(
        repositoryTransportRepository,
        repositoryTransport.adminConnections,
      )
    },
    'git-credential-lease-cleanup': async () => {
      const removedCredentialLeases = cleanupOrphanedGitCredentialLeases(input.appHome)
      if (removedCredentialLeases > 0) {
        log.info('orphaned git credential leases removed', { count: removedCredentialLeases })
      }
    },
    'daemon-identity': providerBootStep(input.provider.provider, 'daemon-identity', async () => {
      await core.daemonActor('postgresql-daemon-system-identity-not-admitted')
    }),
    'skill-identity-barrier': async () => {
      const report = await skillCatalogBoot.runIdentityMigrationBarrier()
      if (report.recoveredOperations > 0 || report.removedHusks > 0 || report.migratedSkills > 0) {
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
        input.db,
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
    'frame-backfill': async () => {
      const backfill = await runFrameBackfillOnBoot({ db: input.db })
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
        resourceCatalog: composeDemoResourceCatalogSeedParticipant(input.db),
        codeCapability: composeCodeCapabilityDemoSeedParticipant(input.db),
      })
      if (result.seeded) log.info('demo content seeded (delete it and it stays deleted)')
    },
    'event-catalog': async () => {
      await eventCenter.initialize()
    },
    'employee-agent-templates': async () => {
      await ensureDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates)
    },
    'employee-tool-catalog': async () => {
      await digitalEmployeePlatformTools.load()
    },
    'employee-authoring-ready': async () => {
      await digitalEmployee.maintenance.ready()
    },
    'employee-writer-state': async () => {
      const writer = await employeeWriterCutover.activate()
      log.info('digital employee writer activated', { ...writer })
    },
    'task-execution-recovery': async () => {
      await runTaskExecutionBootRecovery({
        recoveryEffects: selectLocalBootExecutionRecoveryFactory(input.bootExecutionRecovery),
        persistence: taskExecutionPersistence,
        runtimeSessionLeases,
        lockProof: createDaemonRecoveryAuthorityProof(
          await readDaemonStartupRecoveryAuthority(
            requireStartupLease(input.daemonStartupLease),
            adapter.recoveryProofGeneration(input.provider),
          ),
        ),
        codeHostProbe: (descriptor) =>
          probeCodeHostMutation({
            descriptor,
            resolveConnection: (provider) => codeHostConnections.resolve(provider),
          }),
        log,
      })
    },
    'observation-interrupt': async () => {
      const interruptedCalls = await observationCalls.repairInterrupted(Date.now())
      if (interruptedCalls > 0)
        log.info('observation calls interrupted', { count: interruptedCalls })
    },
    'mr-terminal-reconcile': async () => {
      await webhookTerminalControl.reconcileOnBoot()
    },
    'webhook-delivery-recovery': async () => {
      const recoveredDeliveries = await recoverInterruptedDeliveries(
        integrationModules.webhookDeliveryPersistence,
      )
      if (recoveredDeliveries > 0) {
        log.info('webhook deliveries marked interrupted', { count: recoveredDeliveries })
      }
    },
    'legacy-mission-recovery': () => developmentAutomationModules.recoverWhileDraining(),
    'employee-upgrade-settlement': async () => {
      await digitalEmployee.maintenance.settleAutomaticUpgrades()
    },
    'hosted-targeted-resume': async () => {
      const recoveredTaskIds = input.recoveredExecutionTaskIds?.() ?? []
      if (recoveredTaskIds.length > 0) {
        await taskExecutionProvider.autoResume.run({
          taskIds: recoveredTaskIds,
          breaker: {
            maxPerWindow: input.config.maxAutoRecoveriesPerWindow,
            windowMs: input.config.autoRecoveryWindowMs,
          },
        })
      }
    },
    'resource-reverify': async () => {
      try {
        const bf = await skillCatalogBoot.backfillLegacyVersions()
        const r = await skillCatalogBoot.reverifySnapshots()
        log.info('boot snapshot reverify', {
          ...r,
          legacyBackfilled: bf.backfilled,
          husksRemoved: bf.husksRemoved,
        })
      } catch (error) {
        log.warn('boot snapshot reverify failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
    'bootstrap-admin-hint': async () => {
      if (await core.authRuntime.isBootstrapRequired())
        log.info(
          'first multi-user run? create your admin via `agent-workflow user create --admin --username <name>`',
        )
    },
  }
  if (phase.kind === 'unstarted') {
    const identity = lifecycleSteps['daemon-identity']
    if (identity !== NotApplicable) await identity()
    await eventCenter.initialize()
    await digitalEmployeePlatformTools.load()
    await phase.scope.trackReady(digitalEmployee.maintenance.ready())
  }
  const app = createComposedApp(composeProviderAppDeps(http.composition))
  const webSocket = buildWebSocketAdapter({
    realtime: core.realtime,
    identityAccess: core.identityAccess,
  })
  const runtime: DaemonApplicationRuntime<P> = Object.freeze({
    taskExecution: taskExecutionProvider,
    taskExecutionModules,
    collaborationContext: boundCollaborationContext,
    scheduledTasks: scheduledTaskRuntime,
    scheduledTaskIdentityAccess: integrationIdentityAccess,
    memory: memoryOperations,
    developmentAutomation,
    digitalEmployee,
    digitalEmployeeModules,
    developmentAutomationModules,
    archivedNodeEvents: input.archivedNodeEvents,
    crewStationEvents: integrationModules.crewStationEvents,
    eventCenter,
    fusion: fusionOperations,
    resourceLimits: resourceLimitOperations,
    taskIdleTimeout: taskIdleTimeoutOperations,
    mcpRuntimeTests,
    webhookTerminalControl,
    workspaceMaintenance,
    intentModules,
    resourcePackageActivity: http.resourcePackageApplyActivity,
    // RFC-370 hosted acceptance: claiming while this process's parked driver
    // still drained its admitted work was an owner conflict that the worker
    // retried (and warned about) every second for as long as that work ran.
    // RFC-387: both providers skip an active driver; the worker retries the durable intent.
    driveHumanGateContinuation: taskExecutionModules.gateContinuation,
  })
  return Object.freeze({
    core,
    app,
    webSocket,
    runtime,
    lifecycleSteps,
    modules: Object.freeze({
      core,
      repository: repositoryCredentials,
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
    }),
    operations: Object.freeze({
      workspaceMaintenance,
      resourceLimits: resourceLimitOperations,
      taskIdleTimeout: taskIdleTimeoutOperations,
      integrationIdentityAccess,
      resourcePackageApplyActivity: http.resourcePackageApplyActivity,
    }),
  })
}

function providerBootStep(
  provider: DatabaseProvider,
  id: DaemonBootStepId,
  run: () => Promise<void>,
): DaemonBootSteps[DaemonBootStepId] {
  const declaration: DaemonBootStepDeclaration = DAEMON_BOOT_STEPS.find((step) => step.id === id)!
  return declaration.providers !== undefined && !declaration.providers.includes(provider)
    ? NotApplicable
    : run
}

function requireStartupLease(lease: DaemonStartupLease | undefined): DaemonStartupLease {
  if (lease === undefined) throw new Error('daemon-startup-lease-required')
  return lease
}

function requireRuntimeLegacyConfiguration(
  configuration: RuntimeLegacyConfigurationPort | undefined,
): RuntimeLegacyConfigurationPort {
  if (configuration === undefined) throw new Error('daemon-runtime-legacy-configuration-required')
  return configuration
}
