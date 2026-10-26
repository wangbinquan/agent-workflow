import { initializeClarifyHistory } from '@/modules/collaboration/composition/clarifyHistory'
import { createLocalRuntimeContent } from './contentRuntime'
import { createHistoryRestrictionBindings } from './historyRestrictions'
import { createFileSkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import {
  readActiveEpochInstallation,
  createActiveHistoryRestrictionProvider,
} from '@/modules/system-operations/composition/epochInstallation'
import { createCodeHistoryPackageReader } from '@/modules/code-capability/composition/historyQueries'
import { createLocalReviewArtifacts } from '@/modules/collaboration/composition/contentArtifacts'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// RFC-391 — one passive application graph for daemon and unstarted phases.
import type { DeploymentSelections } from './deploymentProfile'
import {
  DAEMON_SESSION_ADAPTERS,
  type DaemonSessionAdapter,
  type DaemonApplicationProvider,
  type DaemonApplicationDatabase,
} from './daemonSessionAdapters'
import { composeProviderAppComposition, type ProviderAppOwnerInput } from './daemonHttpComposition'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { DEFAULT_DISTILL_POLICY, resolveDistillPolicy } from '@agent-workflow/shared'
import { setMemoryDistillPolicyProvider } from '@/modules/memory/composition'
import { getRuntimeDriver, RUNTIME_KINDS } from '@/services/runtime'
import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'
import { initializeRuntimeRegistryBoot } from '@/modules/runtime-management/composition/runtimeRegistry'
import {
  composeDaemonIntentModules,
  type DaemonIntentModules,
} from '@/bootstrap/daemonModules/intent'
import {
  composeDaemonDigitalEmployeeModules,
  type DaemonDigitalEmployeeModules,
} from '@/bootstrap/daemonModules/digitalEmployee'
import {
  composeDaemonDevelopmentAutomationModules,
  type DaemonDevelopmentAutomationModules,
} from '@/bootstrap/daemonModules/developmentAutomation'
import {
  composeDaemonTaskExecutionModules,
  type DaemonTaskExecutionModules,
} from '@/bootstrap/daemonModules/taskExecution'
import { createEventAutomationDelegatedContextBinding } from '@/modules/identity-access/composition'
import {
  composeDaemonScheduledTaskModules,
  type DaemonScheduledTaskModules,
} from '@/bootstrap/daemonModules/scheduledTasks'
import {
  composeDaemonIntegrationModules,
  type DaemonIntegrationModules,
} from '@/bootstrap/daemonModules/integration'
import {
  composeDaemonFusionModules,
  type DaemonFusionModules,
} from '@/bootstrap/daemonModules/fusion'
import { standaloneModuleAdapters } from '@/bootstrap/daemonModules/adapters'
import { composeDaemonMemoryModules } from '@/bootstrap/daemonModules/memory'
import { composeDaemonObservationModules } from '@/bootstrap/daemonModules/observation'
import {
  composeDaemonProviderCore,
  type SelectedDaemonProviderCore,
} from '@/bootstrap/daemonModules/providerCore'
import { composeDaemonRepositoryCredentials } from '@/bootstrap/daemonModules/repositoryCredentials'
import { composeDaemonResourceCatalogModules } from '@/bootstrap/daemonModules/resourceCatalog'
import {
  DAEMON_BOOT_STEPS,
  NotApplicable,
  type DaemonBootStepId,
  type DaemonBootSteps,
  type DaemonBootStepDeclaration,
} from '@/bootstrap/daemonLifecycleProgram'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'
import type { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { composeDevelopmentPurposeRoot } from './developmentPurposeRoot'
import {
  composeLocalTaskRunRootSelection,
  composeTaskWorkspaceExcludeProfilesFor,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import { selectTaskRunRootSelection } from '@/modules/task-execution/composition/taskRunSelection'
import {
  selectWorkspaceUploadContentFactory,
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { selectDevelopmentWorkspaceEffectBinding } from '@/modules/development-automation/composition'
import {
  composeLocalExecutionAuthority,
  readDaemonStartupRecoveryAuthority,
  type DaemonStartupLease,
} from '@/modules/system-operations/composition'
import { type ApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'
import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'
import type { DigitalEmployeeModuleWithRuntime } from '@/modules/digital-employee/composition'
import { recoverInterruptedTaskDeletes } from '@/services/taskDelete'
import {
  createDaemonRecoveryAuthorityProof,
  runTaskExecutionBootRecovery,
} from '@/modules/task-execution/composition/bootRecovery'
import { selectLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import type { Config } from '@agent-workflow/shared'
import { join } from 'node:path'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import type { SecretBox } from '@/auth/secretBox'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { type RuntimeDiagnosticDependencies } from '@/modules/runtime-management/composition/runtimeManagement'
import { type WebhookDispatcher } from '@/services/webhook/dispatcherTypes'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import { reconcileRepositoryTransportConnectionProjections } from '@/modules/source-control/composition'
import type { composePostgresqlMemoryOperations } from '@/modules/memory/composition'
import type { ResourcePackageApplyActivityQuery } from '@/modules/resource-catalog/public/queries'
import {
  type SelectedTaskExecutionProviderRuntime,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import { selectRepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'
import { readCommittedReviewArtifactBody } from '@/modules/collaboration/public/queries'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition'
import { composeResourceLimitOperations } from './resourceLimits'
import {
  composeTaskIdleTimeoutOperations,
  createTaskIdleTimeoutPersistence,
  type TaskIdleTimeoutOperations,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import type { composeDevelopmentAutomation } from '@/modules/development-automation/composition'
import type { composeMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'
import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import { ensureDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { composeWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { cleanupOrphanedGitCredentialLeases } from '@/util/gitCredentialLease'
import { recoverInterruptedDeliveries } from '@/services/webhook/deliveryStore'
import { Paths } from '@/util/paths'
import { composeDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import type { createLogger } from '@/util/log'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import type { DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import {
  composeProviderAppDeps,
  createComposedApp,
  type ProviderAppCompositionInput,
} from '@/server'
import { buildWebSocketAdapter } from '@/ws/server'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { PRESENCE_CHANNEL, presenceBroadcaster } from '@/ws/broadcaster'
import { composeDaemonRealtimePolicy } from '@/bootstrap/daemonRealtimePolicy'
import type { LocalMcpDiagnosticsCompositionInput as McpDiagnosticsCompositionInput } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { McpDiagnosticsRuntime } from '@/modules/resource-catalog/composition/mcpDiagnostics'

/** Owned finite resource initialization and runtime-test composition for one application. */
export interface UnstartedApplicationScope {
  readonly trackReady: <T>(ready: Promise<T>) => Promise<T>
  readonly createMcpRuntimeTests: (deps: McpDiagnosticsCompositionInput) => McpDiagnosticsRuntime
}

export interface DaemonApplicationInput<
  P extends DatabaseProvider = DatabaseProvider,
> extends DeploymentSelections {
  readonly digitalEmployeeTypePackageDriftPolicy?: 'reject' | 'draft-overlay'
  readonly requiredProvider: DatabaseProvider | null
  readonly provider: DaemonApplicationProvider<P>
  readonly db: DaemonApplicationDatabase<P>
  readonly config: Config
  readonly log: ReturnType<typeof createLogger>
  readonly dbPath?: string
  readonly token: string
  readonly appHome: string
  readonly configPath: string
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly daemonInfoPath: string
  readonly daemonRuntime?: DaemonRuntimeQueries
  readonly daemonStartupLease?: DaemonStartupLease
  readonly lockPath: string
  readonly secretBox: SecretBox
  /** RFC-349 T10 — see `DatabaseSourceWriteWindow`; bootstrap supplies the live one. */
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly databaseMigration: DatabaseMigrationModule
  readonly dbVersion: number
  readonly maintenanceStatus?: NonNullable<
    ProviderAppCompositionInput<
      SelectedDaemonProviderCore<P>
    >['platform']['maintenance']['maintenanceStatus']
  >
  /** Test-only instance ports. The production session never supplies this object. */
  readonly testSeams?: DaemonApplicationTestSeams<P>
}

export interface DaemonApplicationTestSeams<P extends DatabaseProvider = DatabaseProvider> {
  readonly schedulerDriver?: NonNullable<
    Parameters<typeof composeDaemonTaskExecutionModules>[0]['testSeams']
  >['schedulerDriver']
  readonly buildScheduleLaunch?: BuildScheduleLaunch
  readonly runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticDependencies>
  readonly webhookDispatcher?: WebhookDispatcher
  readonly mcpRuntimeTestDependencies?: {
    readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    readonly now?: () => number
    readonly capacity?: number
  }
  readonly intentTestDependencies?: {
    readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
  readonly workflowRuntime?: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['resourceCatalog']['workflows']['runtime']
  readonly opencodeVersion?: string | null
  readonly codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly webhookTerminalControl?: ReturnType<typeof composeMrTerminalControl>
  readonly systemOperations?: SelectedDaemonProviderCore<P>['systemOperations']
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
  readonly resourcePackageActivity: ResourcePackageApplyActivityQuery
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
  if (input.requiredProvider !== null && input.requiredProvider !== input.provider.provider)
    throw new Error('hosted-deployment-requires-postgresql')
  const log = input.log
  const content = input.contentStore ?? createLocalRuntimeContent(input.db, input.appHome)
  const historyRestrictions = input.historyRestrictions ?? createActiveHistoryRestrictionProvider()
  const { nodeRunHistoryRestrictions, gateHistoryRestrictions } =
    createHistoryRestrictionBindings(historyRestrictions)
  const installation = await readActiveEpochInstallation(input.db)
  await initializeClarifyHistory(input.db).catch((error: unknown) => {
    log.warn('clarify history initialization failed; reads will retry', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  const skillContent = input.skillContent ?? createFileSkillContentBinding(input.db, input.appHome)
  const reviewArtifacts =
    input.reviewArtifacts ??
    createLocalReviewArtifacts({ db: input.db, content, appHome: input.appHome })
  const codeHistory = createCodeHistoryPackageReader({
    db: input.db,
    content,
    installation: installation.history,
  })
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
  const applicationConfiguration = input.applicationConfiguration
  const configuration = applicationConfiguration.queries
  const taskLaunchConfiguration = input.taskLaunchConfiguration
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
  const selectedCore = composeDaemonProviderCore({
    daemonToken: input.token,
    db: input.db,
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    sourceWriteWindow: input.sourceWriteWindow,
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
  const core =
    input.testSeams?.systemOperations === undefined
      ? selectedCore
      : Object.freeze({ ...selectedCore, systemOperations: input.testSeams.systemOperations })
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
    mcpRuntimeTestDependencies: input.testSeams?.mcpRuntimeTestDependencies,
    runtimeDiagnosticTestDependencies: input.testSeams?.runtimeDiagnosticTestDependencies,
  })
  const { observationCalls, memorySystemAgentBinding, runtimeSessionLeases, mcpRuntimeTests } =
    observationModules
  const resourceCatalogModules = composeDaemonResourceCatalogModules({
    db: input.db,
    skillContentRoot: input.appHome,
    skillContent,
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
    codeHostFetch: input.testSeams?.codeHostFetch,
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
    content,
    historyRestrictions: nodeRunHistoryRestrictions,
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
      reviewArtifacts,
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
    testSeams:
      phase.kind === 'unstarted'
        ? { schedulerDriver: input.testSeams?.schedulerDriver }
        : undefined,
  })
  const taskExecutionProvider = taskExecutionModules
  const taskExecutionResources = taskExecutionModules.resources
  const taskExecutionPersistence = taskExecutionModules.persistence
  const boundCollaborationContext = taskExecutionModules.collaboration
  const workspaceMaintenance = composeWorkspaceMaintenanceCommand({
    ...composeSourceControlTaskPorts(input.db),
    filesystem: input.workspaceMaintenanceFilesystem,
    appHome: input.appHome,
    terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: invalidateCallGraphIndex,
  })

  const fusionModules: DaemonFusionModules = composeDaemonFusionModules({
    db: input.db,
    appHome: input.appHome,
    skillContent,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.fusion,
  })
  const { fusionOperations } = fusionModules
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
      webhookDispatcher: input.testSeams?.webhookDispatcher,
      webhookTerminalControl: input.testSeams?.webhookTerminalControl,
    },
  })
  const { webhookTerminalControl, eventCenter } = integrationModules
  const digitalEmployeeModules = composeDaemonDigitalEmployeeModules({
    historyRestrictions: nodeRunHistoryRestrictions,
    graphAssist: {
      registry: core.runtimeRegistry,
      getDefaultRuntime: async () => (await configuration.read()).defaultRuntime,
      binding: observationModules.narrativeSystemAgentBinding,
    },
    verificationCommands: input.verificationCommands,
    repositoryRevisionContent: input.repositoryRevisionContent,
    content,
    writerInstallation: installation.writer,
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
      httpTurnFixture: input.testSeams?.intentTestDependencies?.runFn,
    },
  })
  const http = composeProviderAppComposition({
    historyRestrictions: gateHistoryRestrictions,
    codeHistory,
    db: input.db,
    token: input.token,
    appHome: input.appHome,
    secretBox: input.secretBox,
    dbVersion: input.dbVersion,
    opencodeVersion: phase.kind === 'daemon' ? null : (input.testSeams?.opencodeVersion ?? null),
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
      resourcePackageSkillContent: input.resourcePackageSkillContent ?? skillContent.packageContent,
      workspaceContent: input.workspaceContent,
      runtimeInventoryContent: input.runtimeInventoryContent,
      repositoryRevisionContent: input.repositoryRevisionContent,
      codeReviewArtifacts: input.codeReviewArtifacts,
      repositoryRemote: input.repositoryRemote,
    },
    testSeams: {
      codeHostRuntime: { codeHostFetch: input.testSeams?.codeHostFetch },
      workflowRuntime: phase.kind === 'daemon' ? undefined : input.testSeams?.workflowRuntime,
      buildScheduleLaunch: input.testSeams?.buildScheduleLaunch,
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
        configuration: await configuration.read(),
        onRecoverableFailure(error) {
          log.warn('builtin runtime seed on boot failed', {
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
    'skill-operation-recovery': async () => {
      await skillCatalogBoot.recoverOperations()
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
      await digitalEmployeeModules.initializeGraph()
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
        const r = await skillCatalogBoot.reverifySnapshots()
        log.info('boot snapshot reverify', {
          ...r,
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
    await digitalEmployeeModules.initializeGraph()
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
